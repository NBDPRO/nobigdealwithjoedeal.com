/**
 * money-logic.js — Jo's operating system, Build 2 (2026-10-02): the money
 * tab's rules. Pure; the screen is money-ui.js. window.NBDMoney +
 * module.exports (tests).
 *
 * A zero-based paycheck plan: every dollar of one paycheck gets a job, in
 * Jo's order — bills, card minimums, kept subscriptions, the weekly spending
 * buffer and auto-saves first; then the emergency fund until it reaches its
 * target; then everything left goes as extra to the highest-APR card
 * (avalanche); with no debt left, the rest is extra savings. A payoff
 * projection shows when each card is gone and the interest it costs.
 *
 * Money is integer cents throughout. Nicknames only: a name holding 6+
 * digits in a row (an account or card number) is refused.
 */
(function () {
  'use strict';
  const PERIODS = { weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12 };
  const FREQ_LABEL = { weekly: 'every week', biweekly: 'every 2 weeks', semimonthly: 'twice a month', monthly: 'once a month' };

  const cents = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n > 0 ? n : 0; };
  const toCents = (dollars) => { const n = parseFloat(String(dollars == null ? '' : dollars).replace(/[$,\s]/g, '')); return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0; };
  const fmt = (c) => { const n = Math.round(Number(c) || 0); const s = Math.abs(n) / 100; return (n < 0 ? '−$' : '$') + s.toLocaleString('en-US', { minimumFractionDigits: s % 1 ? 2 : 0, maximumFractionDigits: 2 }); };

  /** Nicknames only — never an account or card number. */
  function badName(name) { return /\d{6,}/.test(String(name || '').replace(/[\s-]/g, '')); }
  function cleanName(name) { return String(name || '').trim().slice(0, 40); }

  /** Monthly cents → cents per paycheck (and back). */
  function perPeriod(monthlyCents, freq) { const p = PERIODS[freq] || 26; return Math.round(cents(monthlyCents) * 12 / p); }
  function perMonth(periodCents, freq) { const p = PERIODS[freq] || 26; return Math.round((Number(periodCents) || 0) * p / 12); }

  /** Normalize whatever is stored (never trust shape). */
  function normalize(m) {
    const x = m && typeof m === 'object' ? m : {};
    const list = (a, f) => (Array.isArray(a) ? a : []).map(f).filter(Boolean).slice(0, 40);
    // A row counts once it has a name or an amount (typed in either order);
    // a name holding an account / card number never does.
    const keep = (r, amt) => r && !badName(r.name) && (cleanName(r.name) || cents(amt) > 0);
    const nm = (r) => cleanName(r.name) || 'Unnamed';
    return {
      pay: { amountCents: cents(x.pay && x.pay.amountCents), freq: PERIODS[x.pay && x.pay.freq] ? x.pay.freq : 'biweekly' },
      bills: list(x.bills, (b) => (keep(b, b && b.monthlyCents) ? { name: nm(b), monthlyCents: cents(b.monthlyCents) } : null)),
      cards: list(x.cards, (c) => (keep(c, c && c.balanceCents) ? { name: nm(c), balanceCents: cents(c.balanceCents), aprPct: Math.max(0, Math.min(99, Number(c.aprPct) || 0)), minCents: cents(c.minCents) } : null)),
      subs: list(x.subs, (s) => (keep(s, s && s.monthlyCents) ? { name: nm(s), monthlyCents: cents(s.monthlyCents), keep: s.keep !== false } : null)),
      saves: list(x.saves, (s) => (keep(s, s && s.monthlyCents) ? { name: nm(s), monthlyCents: cents(s.monthlyCents) } : null)),
      fund: { balanceCents: cents(x.fund && x.fund.balanceCents), targetCents: cents(x.fund && x.fund.targetCents) },
      bufferWeeklyCents: cents(x.bufferWeeklyCents),
    };
  }

  /**
   * Payoff projection (avalanche): every month each card pays its minimum,
   * the extra (plus any freed-up minimums) goes to the highest-APR card left.
   * { cards:[{name, months, interestCents}], months, interestCents, capped }
   */
  // extra: a number (the same extra every month) or fn(month) → extra that month.
  function payoff(cards, extra) {
    const cs = (cards || []).filter((c) => c.balanceCents > 0).map((c) => ({ name: c.name, bal: c.balanceCents, apr: c.aprPct, min: c.minCents, months: null, interest: 0 }));
    if (!cs.length) return { cards: [], months: 0, interestCents: 0, capped: false };
    let month = 0, totalInterest = 0;
    const mins = cs.reduce((s, c) => s + c.min, 0);
    const extraFor = typeof extra === 'function' ? extra : () => Math.max(0, extra || 0);
    while (cs.some((c) => c.bal > 0) && month < 600) {
      month++;
      const budget = mins + Math.max(0, extraFor(month) || 0);
      cs.forEach((c) => { if (c.bal > 0) { const i = Math.round(c.bal * c.apr / 100 / 12); c.bal += i; c.interest += i; totalInterest += i; } });
      let pool = budget;
      cs.forEach((c) => { if (c.bal > 0) { const p = Math.min(c.min, c.bal, pool); c.bal -= p; pool -= p; } });
      cs.filter((c) => c.bal > 0).sort((a, b) => b.apr - a.apr || a.bal - b.bal).forEach((c) => { const p = Math.min(c.bal, pool); c.bal -= p; pool -= p; });
      cs.forEach((c) => { if (c.bal <= 0 && c.months == null) c.months = month; });
    }
    const capped = cs.some((c) => c.bal > 0);
    return { cards: cs.map((c) => ({ name: c.name, months: c.months, interestCents: c.interest })), months: capped ? null : month, interestCents: totalInterest, capped };
  }

  /**
   * The paycheck plan. lines sum to the paycheck exactly (zero-based) unless
   * the fixed costs are bigger than the paycheck (shortCents > 0).
   */
  function plan(raw) {
    const m = normalize(raw);
    const f = m.pay.freq;
    const pay = m.pay.amountCents;
    const lines = [];
    const add = (label, c, kind) => { if (c > 0) lines.push({ label, cents: c, kind }); };
    const bills = m.bills.reduce((s, b) => s + b.monthlyCents, 0);
    const mins = m.cards.filter((c) => c.balanceCents > 0).reduce((s, c) => s + Math.min(c.minCents, c.balanceCents), 0);
    const subs = m.subs.filter((s) => s.keep).reduce((s, x) => s + x.monthlyCents, 0);
    const saves = m.saves.reduce((s, x) => s + x.monthlyCents, 0);
    const buffer = Math.round(m.bufferWeeklyCents * 52 / (PERIODS[f]));
    add('Bills', perPeriod(bills, f), 'bills');
    add('Card minimums', perPeriod(mins, f), 'minimums');
    add('Subscriptions you kept', perPeriod(subs, f), 'subs');
    m.saves.forEach((s) => add(s.name + ' (auto-save)', perPeriod(s.monthlyCents, f), 'save'));
    add('Spending buffer', buffer, 'buffer');
    const fixed = lines.reduce((s, l) => s + l.cents, 0);
    let left = pay - fixed;
    const short = left < 0 ? -left : 0;
    left = Math.max(0, left);
    const fundGap = Math.max(0, m.fund.targetCents - m.fund.balanceCents);
    const toFund = Math.min(left, fundGap);
    add('Emergency fund', toFund, 'fund');
    left -= toFund;
    const debts = m.cards.filter((c) => c.balanceCents > 0).sort((a, b) => b.aprPct - a.aprPct || a.balanceCents - b.balanceCents);
    let extraToCards = 0;
    if (debts.length && left > 0) { extraToCards = left; add('Extra to ' + debts[0].name + ' (' + debts[0].aprPct + '% APR, highest)', left, 'extra'); left = 0; }
    if (left > 0) { add('Extra savings', left, 'savings'); left = 0; }
    const cut = m.subs.filter((s) => !s.keep).reduce((s, x) => s + x.monthlyCents, 0);
    // Month by month: the leftover first fills the emergency fund, then all
    // of it goes to the cards — so the debt-free date isn't understated.
    const leftMonthly = perMonth(Math.max(0, pay - fixed), f);
    let fundNeed = fundGap;
    const proj = payoff(m.cards, () => { const toF = Math.min(leftMonthly, fundNeed); fundNeed -= toF; return leftMonthly - toF; });
    return {
      freq: f, freqLabel: FREQ_LABEL[f], payCents: pay, lines, shortCents: short,
      assignedCents: lines.reduce((s, l) => s + l.cents, 0),
      fund: { balanceCents: m.fund.balanceCents, targetCents: m.fund.targetCents, pct: m.fund.targetCents ? Math.min(1, m.fund.balanceCents / m.fund.targetCents) : null,
        paychecksToTarget: fundGap && toFund ? Math.ceil(fundGap / toFund) : (fundGap ? null : 0) },
      debt: { totalCents: debts.reduce((s, c) => s + c.balanceCents, 0), order: debts.map((c) => c.name), payoff: proj },
      cutSavedMonthlyCents: cut,
      monthly: { incomeCents: perMonth(pay, f), billsCents: bills, subsCents: subs, minimumsCents: mins },
    };
  }

  /** What the Finance Board reads (userSettings.dsMoney → my_money). Totals + plan, no account data. */
  function boardView(raw) {
    const m = normalize(raw);
    const p = plan(m);
    return {
      paycheck: fmt(p.payCents) + ' ' + p.freqLabel,
      plan: p.lines.map((l) => ({ line: l.label, amount: fmt(l.cents) })),
      short_by: p.shortCents ? fmt(p.shortCents) : null,
      emergency_fund: { balance: fmt(p.fund.balanceCents), target: fmt(p.fund.targetCents), paychecks_to_target: p.fund.paychecksToTarget },
      cards: m.cards.map((c) => ({ card: c.name, balance: fmt(c.balanceCents), apr_pct: c.aprPct, minimum: fmt(c.minCents) })),
      payoff: { debt_free_months: p.debt.payoff.months, interest_to_pay: fmt(p.debt.payoff.interestCents), order: p.debt.order, per_card: p.debt.payoff.cards.map((c) => ({ card: c.name, months: c.months })) },
      subscriptions: m.subs.map((s) => ({ name: s.name, monthly: fmt(s.monthlyCents), keep: s.keep })),
      monthly: { income: fmt(p.monthly.incomeCents), bills: fmt(p.monthly.billsCents), subscriptions: fmt(p.monthly.subsCents), card_minimums: fmt(p.monthly.minimumsCents) },
    };
  }

  const api = { PERIODS, FREQ_LABEL, toCents, fmt, badName, perPeriod, perMonth, normalize, payoff, plan, boardView };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.NBDMoney = api;
})();
