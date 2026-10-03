#!/usr/bin/env node
/**
 * Jo's operating system, Build 2 (2026-10-02): the 💵 money tab — a
 * zero-based paycheck plan, avalanche payoff projection, and the Finance
 * Board's read-only my_money (docs/pro/daily-success/js/money-logic.js,
 * money-ui.js; functions/agent-mcp-logic.js personalMoney).
 *
 * Run: node tests/tracker-money-2026-10-02.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const M = require(path.join(ROOT, 'docs/pro/daily-success/js/money-logic.js'));
const L = require(path.join(ROOT, 'functions/agent-mcp-logic.js'));
const R = require(path.join(ROOT, 'docs/pro/daily-success/js/review-logic.js'));
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

console.log('A. inputs');
ok('dollars → cents ("$1,234.56", "75", junk)', M.toCents('$1,234.56') === 123456 && M.toCents('75') === 7500 && M.toCents('abc') === 0 && M.toCents('-5') === 0);
ok('per paycheck ↔ per month (biweekly: $1,300/mo → $600)', M.perPeriod(130000, 'biweekly') === 60000 && M.perMonth(60000, 'biweekly') === 130000 && M.perPeriod(130000, 'monthly') === 130000);
ok('an account / card number is never a name', M.badName('4111 1111 1111 1111') && M.badName('Acct 12345678') && !M.badName('Chase Freedom') && !M.badName('Card 4521'));
const n = M.normalize({ cards: [{ name: '4111111111111111', balanceCents: 500 }, { name: 'Chase', balanceCents: 300000, aprPct: 150, minCents: 9000 }, { name: '', balanceCents: 0 }], bills: [{ name: '', monthlyCents: 5000 }], pay: { amountCents: 100000, freq: 'nope' } });
ok('normalize: drops the numbered card + empty rows, caps APR, keeps an unnamed row that has an amount, defaults frequency',
  n.cards.length === 1 && n.cards[0].aprPct === 99 && n.bills.length === 1 && n.bills[0].name === 'Unnamed' && n.pay.freq === 'biweekly', JSON.stringify(n));

console.log('B. the zero-based plan');
const base = {
  pay: { amountCents: 150000, freq: 'biweekly' },
  bills: [{ name: 'Rent', monthlyCents: 120000 }, { name: 'Phone', monthlyCents: 8000 }],
  cards: [{ name: 'Apple', balanceCents: 100000, aprPct: 19, minCents: 3500 }, { name: 'Chase', balanceCents: 300000, aprPct: 27.5, minCents: 9000 }],
  subs: [{ name: 'Netflix', monthlyCents: 1599 }, { name: 'Storage', monthlyCents: 12000, keep: false }],
  saves: [{ name: 'Roth IRA', monthlyCents: 10000 }],
  fund: { balanceCents: 90000, targetCents: 100000 }, bufferWeeklyCents: 7500,
};
const p = M.plan(base);
ok('every dollar gets a job: lines sum to the paycheck exactly', p.assignedCents === p.payCents && p.shortCents === 0, p.assignedCents + ' vs ' + p.payCents);
ok('order: bills, minimums, kept subs, auto-save, buffer, then the fund, then extra',
  p.lines.map((l) => l.kind).join() === 'bills,minimums,subs,save,buffer,fund,extra', p.lines.map((l) => l.kind).join());
ok('the fund only takes what it still needs ($100)', p.lines.find((l) => l.kind === 'fund').cents === 10000);
ok('extra goes to the HIGHEST-APR card (Chase 27.5%), payoff order Chase → Apple', /Chase \(27\.5% APR, highest\)/.test(p.lines.find((l) => l.kind === 'extra').label) && p.debt.order.join() === 'Chase,Apple');
ok('a cut subscription is out of the plan and its saving is shown', !p.lines.some((l) => /Storage/.test(l.label)) && p.cutSavedMonthlyCents === 12000);
const noDebt = M.plan(Object.assign({}, base, { cards: [], fund: { balanceCents: 100000, targetCents: 100000 } }));
ok('no debt and a full fund → the rest is extra savings, still exact', noDebt.lines.slice(-1)[0].kind === 'savings' && noDebt.assignedCents === noDebt.payCents);
const short = M.plan(Object.assign({}, base, { pay: { amountCents: 50000, freq: 'biweekly' } }));
ok('fixed costs bigger than the paycheck → short by the difference, nothing to fund or extra', short.shortCents > 0 && !short.lines.some((l) => l.kind === 'fund' || l.kind === 'extra'));
let exact = true;
for (let i = 0; i < 300; i++) {
  const r = (k) => Math.floor(Math.random() * k);
  const m = { pay: { amountCents: 50000 + r(400000), freq: ['weekly', 'biweekly', 'semimonthly', 'monthly'][r(4)] },
    bills: [{ name: 'B', monthlyCents: r(200000) }], cards: r(2) ? [{ name: 'C', balanceCents: r(900000), aprPct: r(30), minCents: r(20000) }] : [],
    subs: [{ name: 'S', monthlyCents: r(5000), keep: !!r(2) }], saves: r(2) ? [{ name: 'R', monthlyCents: r(50000) }] : [],
    fund: { balanceCents: r(300000), targetCents: r(500000) }, bufferWeeklyCents: r(20000) };
  const q = M.plan(m);
  if (q.shortCents === 0 ? q.assignedCents !== q.payCents : q.assignedCents - q.payCents !== q.shortCents) { exact = false; break; }
}
ok('300 random budgets: always exactly zero-based (or short by exactly the gap)', exact);

console.log('C. payoff projection');
const z = M.payoff([{ name: 'X', balanceCents: 100000, aprPct: 0, minCents: 10000 }], 0);
ok('$1,000 at 0% and $100/mo → 10 months, $0 interest', z.months === 10 && z.interestCents === 0);
const a = M.payoff([{ name: 'Y', balanceCents: 100000, aprPct: 24, minCents: 10000 }], 0);
// Standard amortization: n = −ln(1 − rP/A)/ln(1 + r) = −ln(0.8)/ln(1.02) ≈ 11.27 → 12 payments, ≈ $127 interest.
ok('$1,000 at 24% and $100/mo → 12 months, ~$127 interest (standard amortization)', a.months === 12 && a.interestCents > 12000 && a.interestCents < 13300, JSON.stringify(a));
ok('a payment below the interest never pays off → capped, no fake date', M.payoff([{ name: 'Z', balanceCents: 1000000, aprPct: 30, minCents: 1000 }], 0).capped === true);
const fill = M.plan(Object.assign({}, base, { fund: { balanceCents: 0, targetCents: 300000 } }));
const now = M.plan(Object.assign({}, base, { fund: { balanceCents: 300000, targetCents: 300000 } }));
ok('filling the fund first pushes the debt-free date out (and it says so)', fill.debt.payoff.months > now.debt.payoff.months, fill.debt.payoff.months + ' vs ' + now.debt.payoff.months);

console.log('D. the Finance Board\'s view');
const bv = M.boardView(base);
ok('boardView: paycheck, plan lines, fund, cards, payoff, subs — formatted, no raw objects', /\$1,500 every 2 weeks/.test(bv.paycheck) && bv.plan.length === p.lines.length && bv.cards.length === 2 && bv.payoff.order[0] === 'Chase' && bv.subscriptions.find((s) => s.name === 'Storage').keep === false);
const snap = R.snapshotDoc({ floors: [], todayDk: '2026-10-02', money: bv, scorecard: '' }, Date.now());
ok('the tracker snapshot carries the money view (and it changes the signature)', snap.money === bv && snap.sig !== R.snapshotDoc({ floors: [], todayDk: '2026-10-02', money: null, scorecard: '' }, Date.now()).sig);
const pm = L.personalMoney({ asOf: Date.now(), money: Object.assign({}, bv, { cards: [{ card: '4111 1111 1111 1111', balance: '$1' }].concat(bv.cards) }) }, Date.now());
ok('my_money: the plan comes through; a numbered card name is blanked server-side too', pm.plan.length === bv.plan.length && pm.cards[0].card === '' && pm.cards[1].card === 'Apple' && /not licensed advice/.test(pm.note), JSON.stringify(pm.cards));
ok('my_money before any plan → says where to fill it in', /Plan my paycheck/.test(L.personalMoney({ asOf: 1 }, Date.now()).note));
ok('only the Finance Board can read money (not Coach, not Frank)', L.botAllows('board', 'my_money') && !L.botAllows('coach', 'my_money') && !Object.keys(L.BOTS).some((b) => b !== 'board' && L.botAllows(b, 'my_money')));
ok('my_money is a personal tool (the personal-key lock applies)', L.isPersonalTool('my_money') && /if \(name === 'my_money'\) return L\.toolText\(L\.personalMoney\(d\.dsSnapshot, Date\.now\(\)\)\);/.test(read('functions/agent-mcp.js')));

console.log('E. wiring');
const idx = read('docs/pro/daily-success/index.html');
ok('tracker loads money-logic + money-ui after review-ui, and money.css', idx.indexOf('js/money-logic.js?v=') > idx.indexOf('js/review-ui.js?v=') && idx.indexOf('js/money-ui.js?v=') > idx.indexOf('js/money-logic.js?v=') && /css\/money\.css\?v=\d+/.test(idx));
ok('the plan rides the userSettings sync (survives sign-out)', /\{ key: 'nbd_ds_money',\s+field: 'dsMoney' \}/.test(read('docs/pro/daily-success/ds-firebase-sync.js')));
const ui = read('docs/pro/daily-success/js/money-ui.js');
ok('saving refuses a numbered name and republishes for the Finance Board', /Remove the account \/ card number from a name first/.test(ui) && /NBDReviewUI\.publish\(\)/.test(ui));
ok('the sheet says it is a pressure-test, not advice', /not financial advice/.test(ui));
ok('typed names reach the page escaped', /value="' \+ esc\(val\)/.test(ui) && /esc\(l\.label\)/.test(ui) && !/innerHTML\s*=\s*[^;]*\+\s*(row|c|b|s)\.name\b/.test(ui));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
