/**
 * production-logic.js — the pure half of the after-contract production flow
 * (2026-10-04). UI: js/production.js. Server twin: functions/production-flow-logic.js.
 *
 * Why: in prod, 8 committed jobs had only 2 dates; no lead had ever sat in
 * Permit / Materials Ordered / Materials Here / Crew Scheduled; the crew was
 * set on 0 leads; 30 finished jobs had 0 After photos. The stages were the
 * only production UI and nobody walked them. So the job card gets ONE strip —
 * Permit → Ordered → Delivery → Sub → Start — and the stages become optional.
 *
 * Crews are INDEPENDENT SUBCONTRACTORS who carry their own insurance. Nothing
 * customer-facing built from here calls them employees or "our team": it says
 * "the crew".
 *
 * Calendar rules (Jo, 2026-09-29): warn, never block; a job is a start day +
 * a length (multi-day projects run start..end). Every date here is a local
 * 'YYYY-MM-DD' string handled through NBDScheduleWindow — never
 * new Date('YYYY-MM-DD') (UTC midnight).
 *
 * window.NBDProductionLogic + module.exports (tests).
 */
(function (root) {
  'use strict';

  const W = () => (root && root.NBDScheduleWindow) || (typeof require === 'function' ? require('./schedule-window.js') : null);
  const str = (v) => String(v == null ? '' : v).trim();
  const YMD = /^\d{4}-\d{2}-\d{2}$/;
  const isYmd = (s) => YMD.test(str(s)) && !!W().parseYmd(str(s));
  const nameOf = (l) => str([l && l.firstName, l && l.lastName].filter(Boolean).join(' ')) || str(l && l.name) || str(l && l.address) || 'Customer';
  const firstNameOf = (l) => str(l && l.firstName) || str(nameOf(l).split(' ')[0]);

  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function dowOf(ymd) { const p = W().parseYmd(ymd); return p ? new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay() : -1; }
  function shortDate(ymd) {
    const p = W().parseYmd(str(ymd));
    return p ? DOW[dowOf(ymd)] + ', ' + MON[p.m - 1] + ' ' + p.d : '';
  }
  function longDate(ymd) {
    const p = W().parseYmd(str(ymd));
    return p ? ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dowOf(ymd)] + ', ' + ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][p.m - 1] + ' ' + p.d : '';
  }

  // Committed work (schedule-planner-logic READY) and the production stages.
  const COMMITTED = ['contract_signed', 'job_created', 'permit_pulled', 'materials_ordered',
    'materials_delivered', 'crew_scheduled', 'install_in_progress',
    'warranty_claim', 'warranty_scheduled', 'service_approved'];
  const JOB_STAGES = ['job_created', 'permit_pulled', 'materials_ordered', 'materials_delivered', 'crew_scheduled', 'install_in_progress'];
  const AFTER_STAGES = ['install_in_progress', 'install_complete', 'final_photos'];
  const stageOf = (l) => str(l && (l._stageKey || l.stage)).toLowerCase();

  /** The job's days: { start, end } (end = last day, inclusive), or null. */
  function jobRange(lead) {
    const w = W().normalize(lead || {});
    if (!w) return null;
    return { start: w.date, end: w.endDate || w.date, days: w.days, startTime: w.start };
  }
  const overlaps = (a, b) => !!a && !!b && a.start <= b.end && b.start <= a.end;

  // ═══ subs (the roster) ═══════════════════════════════════════════════
  const TRADES = ['Roofing', 'Gutters', 'Siding', 'Windows', 'Carpentry', 'Painting', 'Other'];

  /** A roster form → a clean sub doc, or { ok:false, message }. */
  function cleanSub(input) {
    const i = input || {};
    const name = str(i.name).slice(0, 80);
    if (!name) return { ok: false, message: 'A sub needs a name.' };
    const exp = str(i.insuranceExpiry);
    if (exp && !isYmd(exp)) return { ok: false, message: 'Pick the certificate expiry date again.' };
    const email = str(i.email).slice(0, 120);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, message: 'That email doesn\'t look right.' };
    return {
      ok: true,
      sub: {
        name,
        phone: str(i.phone).slice(0, 40),
        email,
        trade: str(i.trade).slice(0, 40) || 'Roofing',
        insuranceExpiry: exp || null,
        notes: str(i.notes).slice(0, 1000),
        active: i.active !== false,
      },
    };
  }

  /**
   * The sub's insurance certificate on `onYmd` (the job's first day, else
   * today): none on file / ok / expiring within 30 days / expired.
   */
  function certStatus(sub, onYmd) {
    const exp = str(sub && sub.insuranceExpiry);
    if (!isYmd(exp)) return { state: 'none', label: 'No insurance certificate on file' };
    const a = W().parseYmd(onYmd), b = W().parseYmd(exp);
    const days = a && b ? b.day - a.day : 0;
    if (days < 0) return { state: 'expired', days, label: 'Insurance certificate expired ' + shortDate(exp) };
    if (days <= 30) return { state: 'soon', days, label: 'Insurance certificate expires ' + shortDate(exp) };
    return { state: 'ok', days, label: 'Insured through ' + shortDate(exp) };
  }

  /** Lead fields for a picked sub (or none). `crew` keeps the name every older reader shows. */
  function subFieldsFor(sub) {
    if (!sub) return { subId: null, crew: '' };
    return { subId: String(sub.id), crew: str(sub.name).slice(0, 80) };
  }

  /** Other jobs that have the same sub on overlapping days. */
  function subConflicts(leads, subId, range, excludeLeadId) {
    if (!subId || !range) return [];
    const out = [];
    for (const l of leads || []) {
      if (!l || l.deleted || l.id === excludeLeadId || str(l.subId) !== String(subId)) continue;
      const r = jobRange(l);
      if (overlaps(r, range)) out.push({ id: l.id, name: nameOf(l), start: r.start, end: r.end });
    }
    return out;
  }

  /**
   * Every warning for putting `sub` on a job over `range` (warn, never block):
   * the certificate (as of the job's first day) and double-booking.
   */
  function subWarnings(sub, range, leads, excludeLeadId, todayYmd) {
    if (!sub) return [];
    const out = [];
    const on = (range && range.start) || todayYmd;
    const c = certStatus(sub, on);
    if (c.state === 'expired') out.push('⚠ ' + c.label + (range ? ' — before this job starts' : '') + '. Get a current certificate before they work.');
    else if (c.state === 'none') out.push('⚠ ' + c.label + ' — ask ' + sub.name + ' for one.');
    else if (c.state === 'soon') out.push(c.label + '.');
    const hits = subConflicts(leads, sub.id, range, excludeLeadId);
    if (hits.length) {
      out.push('⚠ ' + sub.name + ' is already on ' + hits.slice(0, 3).map((h) => h.name + ' (' + shortDate(h.start) + (h.end !== h.start ? '–' + shortDate(h.end) : '') + ')').join(', ')
        + (hits.length > 3 ? ' +' + (hits.length - 3) + ' more' : '') + ' — you can still save.');
    }
    return out;
  }

  /**
   * The free-text Crew field the sub picker replaced. Leads with crew text
   * and no subId: link the ones whose text names a roster sub; the rest are
   * names to add to the roster. (Prod had 0 such leads on 2026-10-04.)
   */
  function crewMigration(leads, subs) {
    const byName = new Map((subs || []).filter((s) => s && s.id).map((s) => [str(s.name).toLowerCase(), s]));
    const links = [], newNames = [];
    const seen = new Set();
    for (const l of leads || []) {
      const crew = str(l && l.crew);
      if (!l || l.deleted || !crew || l.subId) continue;
      const hit = byName.get(crew.toLowerCase());
      if (hit) links.push({ leadId: l.id, subId: hit.id, crew: hit.name });
      else if (!seen.has(crew.toLowerCase())) { seen.add(crew.toLowerCase()); newNames.push(crew); }
    }
    return { links, newNames };
  }

  // ═══ permit ══════════════════════════════════════════════════════════
  /** 'filed' | 'none' (not required) | 'todo'. */
  function permitState(lead) {
    const l = lead || {};
    if (l.permitNotRequired === true) return 'none';
    if (str(l.permitFiledAt)) return 'filed';
    return 'todo';
  }

  /**
   * The permit editor → lead patch. "Not required" reuses #2128's
   * permitNotRequired (+ its timestamp), which the Materials Ordered gate
   * (crm-stages.js missingRequiredFields) already accepts — never a fake
   * "filed" stamp. An existing filed stamp is kept on a re-save.
   */
  function permitPatch(input, lead, nowIso) {
    const i = input || {};
    const l = lead || {};
    const number = str(i.number).slice(0, 60);
    const city = str(i.city).slice(0, 80);
    if (i.state === 'filed') return { permitFiledAt: str(l.permitFiledAt) || nowIso, permitNotRequired: false, permitNumber: number, permitCity: city };
    if (i.state === 'none') return { permitNotRequired: true, permitNotRequiredAt: str(l.permitNotRequiredAt) || nowIso, permitFiledAt: '', permitNumber: '', permitCity: city };
    return { permitFiledAt: '', permitNotRequired: false, permitNumber: number, permitCity: city };
  }

  // ═══ material orders ═════════════════════════════════════════════════
  const STORES = ['Gulf Eagle Supply', 'Home Depot', "Lowe's", 'Menards', 'ABC Supply', 'Other'];
  const ORDER_STATUS = ['planned', 'ordered', 'delivered', 'cancelled'];

  /** A materials list (materials-list.js buildList) → order items, quantities only — NO prices. */
  function orderItemsFromList(list) {
    const out = [];
    for (const g of (list && list.groups) || []) {
      for (const i of g.items || []) {
        out.push({ name: str(i.name).slice(0, 120), code: str(i.code).slice(0, 40), qty: Number(i.buyQty) || 0, unit: str(i.buyUnit).slice(0, 30), store: str(g.store).slice(0, 60) });
        if (out.length >= 200) return out;
      }
    }
    return out;
  }

  /** The Home Depot SKUs the price book has bought for this lead — names and quantities, never cents. */
  function hdSkusForLead(priceBookItems, leadId) {
    const out = [];
    if (!leadId) return out;
    for (const k of Object.keys(priceBookItems || {})) {
      const e = priceBookItems[k];
      if (!e || str(e.store).toLowerCase() !== 'homedepot' || !Array.isArray(e.history)) continue;
      const mine = e.history.filter((h) => h && h.leadId === leadId);
      if (!mine.length) continue;
      out.push({ sku: str(e.sku).slice(0, 30), desc: str(e.desc).slice(0, 120), qty: mine.reduce((a, h) => a + (Number(h.qty) || 0), 0), date: str(mine[0].date) });
    }
    out.sort((a, b) => a.desc.localeCompare(b.desc));
    return out.slice(0, 60);
  }

  /** An order form → a clean order doc, or { ok:false, message }. */
  function cleanOrder(input, lead) {
    const i = input || {};
    const l = lead || {};
    const store = str(i.store).slice(0, 80);
    if (!store) return { ok: false, message: 'Pick the store.' };
    const orderedDate = str(i.orderedDate), deliveryDate = str(i.deliveryDate);
    if (orderedDate && !isYmd(orderedDate)) return { ok: false, message: 'Pick the order date again.' };
    if (deliveryDate && !isYmd(deliveryDate)) return { ok: false, message: 'Pick the delivery date again.' };
    if (orderedDate && deliveryDate && deliveryDate < orderedDate) return { ok: false, message: 'The delivery can\'t be before the order.' };
    let status = ORDER_STATUS.indexOf(str(i.status)) !== -1 ? str(i.status) : (orderedDate ? 'ordered' : 'planned');
    const order = {
      store,
      orderNumber: str(i.orderNumber).slice(0, 40) || null,
      orderedDate: orderedDate || '',
      deliveryDate: deliveryDate || '',
      status,
      notes: str(i.notes).slice(0, 1000),
      userId: l.userId || null,
      companyId: l.companyId || null,
    };
    if (Array.isArray(i.items)) order.items = i.items.slice(0, 200);
    if (Array.isArray(i.hdSkus)) order.hdSkus = i.hdSkus.slice(0, 60);
    return { ok: true, order };
  }

  /** '' or the warning for a delivery that lands after the job starts. */
  function deliveryWarning(order, lead) {
    if (!order || order.status === 'cancelled' || order.status === 'delivered') return '';
    const r = jobRange(lead);
    const d = str(order.deliveryDate);
    if (!r || !isYmd(d) || d <= r.start) return '';
    return '⚠ Delivery ' + shortDate(d) + ' is after the start day (' + shortDate(r.start) + ') — move one of them.';
  }

  /** Several orders → what the strip shows: the last order placed and the next (or last) delivery. */
  function summarizeOrders(orders) {
    const live = (orders || []).filter((o) => o && o.status !== 'cancelled' && !o.deleted);
    const placed = live.filter((o) => isYmd(o.orderedDate) || o.status === 'ordered' || o.status === 'delivered')
      .sort((a, b) => str(b.orderedDate).localeCompare(str(a.orderedDate)));
    const pending = live.filter((o) => isYmd(o.deliveryDate) && o.status !== 'delivered').sort((a, b) => a.deliveryDate.localeCompare(b.deliveryDate));
    const done = live.filter((o) => o.status === 'delivered');
    return {
      ordered: placed.length ? { store: placed[0].store, date: placed[0].orderedDate || '' } : null,
      delivery: pending.length ? { date: pending[0].deliveryDate, store: pending[0].store, delivered: false }
        : (done.length ? { date: str(done[0].deliveryDate), store: done[0].store, delivered: true } : null),
      count: live.length,
    };
  }

  // ═══ the production strip ════════════════════════════════════════════
  /**
   * Permit → Ordered → Delivery → Sub → Start, each { key, label, value,
   * done, warn }. `sub` is the roster doc for lead.subId (or null).
   */
  function stripSteps(lead, orders, sub, todayYmd) {
    const l = lead || {};
    const ps = permitState(l);
    const s = summarizeOrders(orders);
    const r = jobRange(l);
    const steps = [];
    steps.push({ key: 'permit', label: 'Permit', done: ps !== 'todo',
      value: ps === 'filed' ? ('Filed' + (str(l.permitNumber) ? ' #' + str(l.permitNumber) : '') + (str(l.permitCity) ? ' · ' + str(l.permitCity) : ''))
        : ps === 'none' ? 'Not required' + (str(l.permitCity) ? ' · ' + str(l.permitCity) : '') : 'Not set', warn: '' });
    steps.push({ key: 'ordered', label: 'Ordered', done: !!s.ordered,
      value: s.ordered ? (s.ordered.store + (s.ordered.date ? ' · ' + shortDate(s.ordered.date) : '')) : 'Not yet', warn: '' });
    const dw = (orders || []).map((o) => deliveryWarning(o, l)).find(Boolean) || '';
    steps.push({ key: 'delivery', label: 'Delivery', done: !!(s.delivery && (s.delivery.delivered || isYmd(s.delivery.date))),
      value: s.delivery ? ((s.delivery.delivered ? 'Here · ' : '') + (s.delivery.date ? shortDate(s.delivery.date) : 'No date')) : 'No date', warn: dw });
    const cert = sub ? certStatus(sub, (r && r.start) || todayYmd) : null;
    steps.push({ key: 'sub', label: 'Sub', done: !!sub,
      value: sub ? sub.name : (str(l.crew) ? str(l.crew) + ' (not on roster)' : 'Not picked'),
      warn: cert && (cert.state === 'expired' || cert.state === 'none') ? '⚠ ' + cert.label : '' });
    steps.push({ key: 'start', label: 'Start', done: !!r,
      value: r ? W().formatWindow(l, todayYmd) : (W().mondayOf(str(l.scheduledWeek)) ? 'Week of ' + shortDate(W().mondayOf(str(l.scheduledWeek))) : 'No date'), warn: '' });
    return steps;
  }

  // ═══ "Send to sub" job sheet ═════════════════════════════════════════
  /**
   * The text Jo sends a sub from his own phone (share sheet). Address + map
   * link, start, scope, the materials list with NO prices, access notes. The
   * homeowner's phone and every dollar figure stay out.
   */
  function jobSheet(o) {
    const opts = o || {};
    const l = opts.lead || {};
    const r = jobRange(l);
    const lines = [];
    lines.push('JOB SHEET — ' + (str(l.address) || nameOf(l)));
    if (opts.sub && opts.sub.name) lines.push('For: ' + opts.sub.name);
    lines.push('');
    if (str(l.address)) {
      lines.push('Address: ' + str(l.address));
      lines.push('Map: https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(str(l.address)));
    }
    if (r) {
      const w = W().normalize(l);
      lines.push('Start: ' + longDate(r.start) + (w && w.start ? ' · ' + W().timeLabel(w) : ''));
      lines.push('Days: ' + r.days + (r.days > 1 ? ' (through ' + longDate(r.end) + ')' : ''));
    } else if (W().mondayOf(str(l.scheduledWeek))) {
      lines.push('Start: the week of ' + longDate(W().mondayOf(str(l.scheduledWeek))) + ' — exact day to follow');
    } else {
      lines.push('Start: date to follow');
    }
    const scope = str(l.scopeOfWork) || str(opts.scope);
    lines.push('');
    lines.push('Scope: ' + (scope || [str(l.jobType), str(l.subType)].filter(Boolean).join(' · ').replace(/_/g, ' ') || 'see estimate'));
    const items = [];
    for (const ord of opts.orders || []) {
      if (!ord || ord.status === 'cancelled') continue;
      for (const i of ord.items || []) items.push('- ' + (i.qty ? i.qty + ' ' : '') + (i.unit ? i.unit + ' — ' : '') + i.name);
    }
    if (items.length) {
      lines.push('');
      lines.push('Materials:');
      for (const x of items.slice(0, 80)) lines.push(x);
      if (items.length > 80) lines.push('- …and ' + (items.length - 80) + ' more');
    }
    const s = summarizeOrders(opts.orders);
    if (s.delivery && s.delivery.date) lines.push('Delivery: ' + longDate(s.delivery.date) + (s.delivery.store ? ' (' + s.delivery.store + ')' : '') + (s.delivery.delivered ? ' — on site' : ''));
    const access = str(l.accessNotes);
    lines.push('');
    lines.push('Access: ' + (access || 'none noted'));
    // Belt and braces: a $ amount never leaves in a sub's sheet.
    return lines.join('\n').replace(/\$\s?\d[\d,]*(\.\d+)?/g, '');
  }

  // ═══ rain-day push ═══════════════════════════════════════════════════
  /** ymd + n working days (Mon–Fri). n may be negative. */
  function addWorkingDays(ymd, n) {
    let d = str(ymd);
    let left = Math.abs(parseInt(n, 10) || 0);
    const step = (parseInt(n, 10) || 0) < 0 ? -1 : 1;
    while (left > 0) {
      d = W().addDays(d, step);
      const dow = dowOf(d);
      if (dow !== 0 && dow !== 6) left--;
    }
    return d;
  }

  /**
   * "Push this job and everything after it by N working days." Every
   * committed job with a day on or after the picked job's start (the picked
   * one included) moves its start by N working days and keeps its number of
   * WORKING days (weekends are skipped). Week-only plans and leads that are
   * not committed work (an inspection, a lost lead) are left alone. → [{ id, name,
   * from: {start,end}, to: {start,end}, fields }] where fields go through
   * NBDScheduleWindow.check (via `fieldsFor`, schedule-planner-logic).
   */
  function rainPushPlan(leads, fromLeadId, n, opts) {
    const o = opts || {};
    const days = Math.max(1, Math.min(10, parseInt(n, 10) || 0));
    const norm = typeof o.normalize === 'function' ? o.normalize : (s) => str(s).toLowerCase();
    const pick = (leads || []).find((l) => l && l.id === fromLeadId);
    const pr = jobRange(pick);
    if (!pr) return [];
    const out = [];
    for (const l of leads || []) {
      if (!l || l.deleted) continue;
      const r = jobRange(l);
      if (!r || r.start < pr.start) continue;
      if (l.id !== fromLeadId && COMMITTED.indexOf(norm(l.stage || '')) === -1) continue;
      // Keep the job's WORKING days: a Thu–Fri job pushed a day runs Fri–Mon,
      // not Fri–Sat.
      let work = 0;
      for (let k = 0; k < r.days; k++) { const dw = dowOf(W().addDays(r.start, k)); if (dw !== 0 && dw !== 6) work++; }
      const start = addWorkingDays(r.start, days);
      const end = addWorkingDays(start, Math.max(1, work) - 1);
      const fields = {
        scheduledDate: start,
        scheduledStart: l.scheduledStart || null,
        scheduledDurationMin: l.scheduledDurationMin == null || l.scheduledDurationMin === '' ? null : l.scheduledDurationMin,
        scheduledEndDate: end !== start ? end : null,
        scheduledWeek: null,
      };
      out.push({ id: l.id, name: nameOf(l), from: { start: r.start, end: r.end }, to: { start, end }, fields });
    }
    out.sort((a, b) => a.from.start.localeCompare(b.from.start) || a.name.localeCompare(b.name));
    return out;
  }

  // ═══ after install ═══════════════════════════════════════════════════
  const AFTER_CHECKLIST = [
    { id: 'after_photos', label: 'After photos — every slope, flashings, gutters, the yard' },
    { id: 'walk_sub', label: 'Walk the roof with the sub' },
    { id: 'magnet', label: 'Magnet sweep — driveway, beds, lawn' },
    { id: 'walk_owner', label: 'Walkthrough with the homeowner' },
  ];

  /** Show the After photos + walkthrough checklist? Once install is under way or the last day has come. */
  function showAfterChecklist(lead, todayYmd) {
    const s = stageOf(lead);
    if (AFTER_STAGES.indexOf(s) !== -1) return true;
    const r = jobRange(lead);
    return JOB_STAGES.indexOf(s) !== -1 && !!r && r.end <= todayYmd;
  }

  /** The soft warning for a move to Final Photos with no After photos ('' = none). */
  function finalPhotosWarning(newStage, afterCount) {
    if (str(newStage) !== 'final_photos') return '';
    if (Number(afterCount) > 0) return '';
    return 'No After photos on this job yet — take them before the final invoice. (The move went through.)';
  }

  // ═══ crew-scheduled email (a DRAFT Jo reviews) ═══════════════════════
  /**
   * The schedule lines the homeowner email is filled from — the job's real
   * start time, its day count and its week — in place of the old hard-coded
   * "typically 7-8 AM" and "1-2 days". Says "the crew", never "our team".
   */
  function crewEmailFields(lead) {
    const l = lead || {};
    const w = W().normalize(l);
    const wk = W().mondayOf(str(l.scheduledWeek));
    if (!w) {
      return {
        scheduledDate: wk ? 'the week of ' + longDate(wk) : '[to be confirmed]',
        arrivalLine: wk ? 'We\'ll confirm your exact day as that week\'s schedule comes together.' : 'I\'ll confirm the arrival time with you before installation day.',
        lengthLine: '',
      };
    }
    const t = w.start ? W().timeLabel(w) : '';
    return {
      scheduledDate: longDate(w.date) + (w.days > 1 ? ' through ' + longDate(w.endDate) : ''),
      arrivalLine: t ? 'The crew is scheduled to arrive around ' + t + '.' : 'I\'ll confirm the crew\'s arrival time with you the day before.',
      lengthLine: w.days > 1 ? 'The work is planned for ' + w.days + ' days.' : (w.durationMin ? 'The work should take about ' + (w.durationMin >= 60 ? Math.round(w.durationMin / 60 * 10) / 10 + ' hours' : w.durationMin + ' minutes') + '.' : 'The work is planned for one day.'),
    };
  }

  // ═══ tomorrow's installs ═════════════════════════════════════════════
  /** The pre-written reminder Jo sends from his own phone. */
  function reminderText(lead, ctx) {
    const c = ctx || {};
    const l = lead || {};
    const w = W().normalize(l);
    const t = w && w.start ? ' around ' + W().timeLabel(w) : '';
    const who = [str(c.repName), str(c.companyName) ? 'with ' + str(c.companyName) : ''].filter(Boolean).join(' ');
    return 'Hi ' + firstNameOf(l) + (who ? ', this is ' + who : '') + '. A reminder that the crew is scheduled at '
      + (str(l.address) || 'your home') + ' tomorrow' + t + '. Please move vehicles out of the driveway and away from the house, '
      + 'and keep pets inside while the crew works. Questions? Just reply here. Thank you!';
  }

  /** Jobs starting tomorrow (or on a later day of a multi-day job? no — the first day only). */
  function tomorrowInstalls(leads, todayYmd, ctx) {
    const tomorrow = W().addDays(todayYmd, 1);
    const out = [];
    for (const l of leads || []) {
      if (!l || l.deleted) continue;
      const r = jobRange(l);
      if (!r || r.start !== tomorrow) continue;
      const s = stageOf(l);
      if (s === 'lost' || s === 'closed') continue;
      out.push({ id: l.id, name: nameOf(l), address: str(l.address), phone: str(l.phone), email: str(l.email),
        when: W().formatWindow(l, todayYmd), text: reminderText(l, ctx) });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  // ═══ signed jobs that need a week ════════════════════════════════════
  function needsWeek(leads, opts) {
    const norm = opts && typeof opts.normalize === 'function' ? opts.normalize : (s) => str(s).toLowerCase();
    return (leads || []).filter((l) => l && l.id && !l.deleted && COMMITTED.indexOf(norm(l.stage || '')) !== -1
      && !isYmd(l.scheduledDate) && !W().mondayOf(str(l.scheduledWeek)));
  }

  // ═══ the 7-day busy strip ════════════════════════════════════════════
  const STRIP_FIRST_HOUR = 7;
  const STRIP_LAST_HOUR = 19;   // exclusive: 7 am – 7 pm, 12 one-hour cells

  /**
   * 7 days from today, each 12 hourly cells (7 am–7 pm), shaded by what is
   * there: 'job' (a CRM job), 'busy' (Google busy — Jo's own calendar and
   * the NBD Jobs events, from getBusyTimes), 'deliv' (a delivery day, all
   * day, lightest), else 'free'. A job wins over busy over a delivery.
   * localToUtcMs(ymd, 'HH:MM') → ms (NBDScheduleWindow.localToUtcMs).
   */
  function busyStrip(o) {
    const opts = o || {};
    const L = opts.localToUtcMs || W().localToUtcMs;
    const today = opts.today;
    const n = opts.days || 7;
    const rank = { free: 0, deliv: 1, busy: 2, job: 3 };
    const out = [];
    for (let i = 0; i < n; i++) {
      const date = W().addDays(today, i);
      const cells = [];
      for (let h = STRIP_FIRST_HOUR; h < STRIP_LAST_HOUR; h++) cells.push({ hour: h, kind: 'free', titles: [] });
      const mark = (startMs, endMs, kind, title) => {
        cells.forEach((c) => {
          const cs = L(date, (c.hour < 10 ? '0' : '') + c.hour + ':00'), ce = cs + 3600000;
          if (startMs < ce && endMs > cs) {
            if (rank[kind] > rank[c.kind]) c.kind = kind;
            if (title && c.titles.indexOf(title) === -1 && c.titles.length < 3) c.titles.push(title);
          }
        });
      };
      const day = { date, label: shortDate(date), cells, jobs: [], deliveries: [] };
      for (const b of opts.blocks || []) mark(Number(b.startMs), Number(b.endMs), 'busy', (b.titles && b.titles[0]) || 'Busy');
      for (const ord of opts.orders || []) {
        if (!ord || ord.status === 'cancelled' || str(ord.deliveryDate) !== date) continue;
        day.deliveries.push(ord);
        mark(L(date, '00:00'), L(W().addDays(date, 1), '00:00'), 'deliv', '🚚 ' + (ord.store || 'Delivery'));
      }
      for (const l of opts.leads || []) {
        if (!l || l.deleted || !W().coversDay(l, date)) continue;
        const w = W().normalize(l);
        day.jobs.push({ id: l.id, name: nameOf(l) });
        let s, e;
        if (w.start && w.days === 1) {
          s = L(date, w.start);
          e = s + (w.durationMin ? w.durationMin * 60000 : 60 * 60000);
        } else {
          s = L(date, w.start && date === w.date ? w.start : '07:00');
          e = L(date, '18:00');
        }
        mark(s, e, 'job', nameOf(l));
      }
      out.push(day);
    }
    return out;
  }

  const api = {
    COMMITTED, JOB_STAGES, TRADES, STORES, ORDER_STATUS, AFTER_CHECKLIST, STRIP_FIRST_HOUR, STRIP_LAST_HOUR,
    shortDate, longDate, jobRange, cleanSub, certStatus, subFieldsFor, subConflicts, subWarnings, crewMigration,
    permitState, permitPatch, orderItemsFromList, hdSkusForLead, cleanOrder, deliveryWarning, summarizeOrders,
    stripSteps, jobSheet, addWorkingDays, rainPushPlan, showAfterChecklist, finalPhotosWarning,
    crewEmailFields, reminderText, tomorrowInstalls, needsWeek, busyStrip,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDProductionLogic = api;
})(typeof window !== 'undefined' ? window : null);
