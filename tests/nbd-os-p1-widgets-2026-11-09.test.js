/**
 * tests/nbd-os-p1-widgets-2026-11-09.test.js - NBD OS P1: the Needs you, Storm,
 * Closes this week and Money widgets (documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §5).
 *
 * All read-only, read cost 0: the Today plan in memory (NBDToday.last(), never
 * compute()), _leads / _estimates / _notifications, NBDRevenue.cached(), and
 * Storm Center's localStorage cache. Every number on screen is one the data
 * counted; missing data shows a plain line with no number. Each is hidden for a
 * role whose sidebar hides its view (catalog nav), and Money also for a viewer;
 * a hidden widget is not painted but stays saved through an edit. Money is the
 * member's OWN collected this month, in cents, formatted by today-plan.js
 * fmtCents. The renderers live in os/widgets-p1.js, the runtime ScriptLoader
 * bundle 'oshomep1'; the Add sheet lists them under Today and Money.
 *
 * Run: node tests/nbd-os-p1-widgets-2026-11-09.test.js
 */
'use strict';
const path = require('path');
const vm = require('vm');
const H = require('./lib/nbd-os-home-harness.js');
const { ROOT, read, makeWin, NOW, byKey, text, click, noComments } = H;

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 400) : '')); }
}
const J = (v) => JSON.stringify(v);
const req = (p) => { try { return require(path.join(ROOT, p)); } catch (e) { return null; } };
const HL = req('docs/pro/js/os/home-logic.js');
const P1_JS = read('docs/pro/js/os/widgets-p1.js');
const HOME_JS = read('docs/pro/js/os/home.js');
const HOME_CSS = read('docs/pro/css/os/home.css');
const tick = () => new Promise((r) => setImmediate(r));
const numbersIn = (s) => (String(s).match(/\d[\d,.]*/g) || []);

/**
 * A home of these items (the desk column, which keeps their order; o.phone = the phone page, which packs S
 * widgets in pairs), with today-plan.js and (opt) the real collected-revenue.js in the window.
 */
async function mount(items, opts) {
  const o = opts || {};
  const phone = !!o.phone;
  const T = makeWin(Object.assign({ surface: phone ? 'phone' : 'desk', loader: true, nav: ['storm'], home: phone ? { phone: items, desk: [] } : { phone: [], desk: items } }, o));
  T.W.NBDTodayPlan = req('docs/pro/js/today-plan.js');
  if (o.revenue) {
    vm.runInContext(read('docs/pro/js/collected-revenue.js'), T.W, { filename: 'collected-revenue.js' });
    const invs = o.revenue;
    T.W.NBDRevenue.cached = () => (invs === 'none' ? null : invs);
    T.W.NBDRevenue.status = () => (invs === 'none' ? (o.revStatus || 'checking') : 'ok');
  }
  if (o.closes) T.W.NBDClosesWeekLogic = req('docs/pro/js/closes-week-logic.js');
  if (o.before) o.before(T);
  T.W._impl.mount({ surface: phone ? 'phone' : 'desktop' });
  await tick();
  const ph = phone ? T.document.getElementById('osPhone') : T.document.querySelector('.os-widgets');
  return { T, ph, card: (k) => byKey(ph, k) };
}

(async () => {
  try {
    console.log('\n1. the catalog entries and the Add sheet');
    {
      const want = { needsyou: [['s', 'm', 'l'], 'today', 'crm'], storm: [['s', 'm'], 'today', 'storm'], closes: [['m', 'l'], 'money', 'crm'], money: [['s', 'm'], 'money', 'money'] };
      Object.keys(want).forEach((id) => {
        const c = HL.CATALOG[id];
        ok(id + ': sizes ' + want[id][0].join('/') + ', group ' + want[id][1] + ', nav ' + want[id][2] + ', read cost 0',
          c && J(c.sizes) === J(want[id][0]) && c.cat === want[id][1] && c.nav === want[id][2] && c.reads === 0 && c.p1 === true, J(c));
      });
      ok('Money is marked money (a viewer or a role without the Money view never gets it)', HL.CATALOG.money.money === true);
      ok('the Add sheet groups: Today, Money, You, Tools', J(HL.GROUPS.map((g) => g.title)) === J(['Today', 'Money', 'You', 'Tools']));
      const { T } = await mount([{ id: 'glance', s: 'm' }], { phone: true });
      const L = T.W.NBDOSLayout.state();
      L.home.setEditing(true);
      L.home.openAdd();
      const dlg = T.document.querySelector('dialog.os-hw-add');
      const groupOf = (id) => { const b = dlg.querySelector('[data-oshw-add="' + id + '"]'); const g = b && b.closest('.os-hw-add-group'); return g ? text(g.querySelector('h3')) : ''; };
      ok('Needs you, Storm and Smart Stack are under Today', groupOf('needsyou') === 'Today' && groupOf('storm') === 'Today' && groupOf('stack') === 'Today');
      ok('Closes this week and Money are under Money', groupOf('closes') === 'Money' && groupOf('money') === 'Money');
    }

    console.log('\n2. hidden for a role whose nav hides the data');
    {
      const items = [{ id: 'storm', s: 's' }, { id: 'money', s: 's' }, { id: 'glance', s: 'm' }];
      const a = await mount(items, { nav: [], phone: true });   // no Storm Center in this member's sidebar
      ok('no Storm view in the sidebar: Storm is not painted', !a.card('storm-1') && !!a.card('money-1'));
      const L = a.T.W.NBDOSLayout.state();
      L.home.setEditing(true);
      L.home.openAdd();
      ok('…and not offered in the Add sheet', !a.T.document.querySelector('dialog.os-hw-add [data-oshw-add="storm"]'));
      a.T.document.querySelector('dialog.os-hw-add').close();
      click(a.T.dom, a.card('glance-1').querySelector('[data-oshw-ed="remove"]'));
      a.T.fire(700);
      ok('…but an edit keeps it saved (it comes back if the role gets the view)', J(a.T.saved().phone.map((x) => x.id)) === J(['money', 'storm']), J(a.T.saved().phone));
      const v = await mount(items, { role: 'viewer', phone: true });
      ok('a viewer never gets Money', !v.card('money-1') && !!v.card('storm-1'));
      const b = await mount(items, { phone: true, before: (T) => { T.document.querySelector('.sidebar [data-target="money"]').classList.add('dn'); } });
      ok('a role whose sidebar hides Money never gets Money', !b.card('money-1'));
      ok('the phone page counts only what it paints (cellItems drops hidden widgets)',
        J(b.T.W.NBDOSLayout.state().home.cellItems(items).map((x) => x.id)) === J(['storm', 'glance']));
    }

    console.log('\n2b. a held (role-hidden) widget counts against the item cap (24 in P1), so no edit can push it out');
    {
      // a viewer: Money is held (never painted), 23 visible widgets, 24 in all = full
      const eleven = Array.from({ length: 23 }, () => ({ id: 'glance', s: 's' }));
      const f = await mount(eleven.concat([{ id: 'money', s: 's' }]), { role: 'viewer' });
      const L = f.T.W.NBDOSLayout.state();
      L.home.setEditing(true);
      L.home.openAdd();
      const dlg = f.T.document.querySelector('dialog.os-hw-add');
      ok('the Add sheet says the home is full (23 shown + 1 held)', !!dlg.querySelector('.os-hw-add-full'));
      ok('…and every Add chip is disabled', [...dlg.querySelectorAll('[data-oshw-add]')].every((b) => b.hasAttribute('disabled')));
      const chip = dlg.querySelector('[data-oshw-add="glance"][data-size="s"]');
      chip.removeAttribute('disabled');   // even a forced tap must not add past the cap
      click(f.T.dom, chip);
      f.T.fire(700);
      const s1 = f.T.saved().desk;
      ok('…a forced Add saves nothing past the cap; Money stays saved', s1.length === 24 && s1.some((x) => x.id === 'money'), J(s1));
      // a stack: 21 glance + a 2-card stack (23) + held Money = 24; a 3rd card has no room
      const nine = Array.from({ length: 21 }, () => ({ id: 'glance', s: 's' }));
      const g = await mount(nine.concat([{ id: 'stack', s: 'm', items: ['upnext', 'daily'] }, { id: 'money', s: 's' }]), { role: 'viewer' });
      const G = g.T.W.NBDOSLayout.state();
      G.home.setEditing(true);
      click(g.T.dom, g.card('stack-1').querySelector('[data-oshw-ed="cards"]'));
      const cd = g.T.document.querySelector('dialog.os-hw-cards');
      const off = cd && cd.querySelector('[data-oshw-card="coach"]');
      ok('the stack\'s Cards sheet disables an Off card when the held widget fills the cap', off && off.hasAttribute('disabled'), cd && cd.innerHTML.slice(0, 300));
      if (off) { off.removeAttribute('disabled'); click(g.T.dom, off); g.T.fire(700); }
      const s2 = g.T.saved().desk;
      ok('…a forced toggle keeps Money saved', s2.some((x) => x.id === 'money') && s2.find((x) => x.id === 'stack').items.length === 2, J(s2));
    }

    console.log('\n3. Needs you: the Today plan\'s own sections, counted');
    {
      const plan = H.plan();
      const ny = HL.needsYou(plan, { money: true });
      ok('groups from the plan: 1 person, 1 follow-up, 1 estimate (total 3)', ny.total === 3 && J(ny.groups.map((g) => [g.id, g.n])) === J([['calls', 1], ['followups', 1], ['estimates', 1]]), J(ny));
      const p2 = Object.assign({}, plan, { promises: [{}, {}], stalled: [{}], money: [{}], noNextStep: { count: 4 } });
      const g2 = HL.needsYou(p2, { money: false, waiting: { kind: 'lead', n: 2 } });
      ok('promises, follow-ups (promised + stalled), no-next-step and waiting leads each count', J(g2.groups.map((g) => [g.id, g.n])) === J([['waiting', 2], ['calls', 1], ['promises', 2], ['followups', 2], ['estimates', 1], ['nns', 4]]), J(g2.groups));
      ok('money group only when the role sees money', !g2.groups.some((g) => g.id === 'money') && HL.needsYou(p2, { money: true }).groups.some((g) => g.id === 'money'));
      ok('a waiting missed call is not a "new lead"', !HL.needsYou(plan, { waiting: { kind: 'call', n: 1 } }).groups.some((g) => g.id === 'waiting'));
      ok('no plan -> null', HL.needsYou(null) === null);
      const m = await mount([{ id: 'needsyou', s: 's' }, { id: 'needsyou', s: 'm' }, { id: 'needsyou', s: 'l' }]);
      ok('S: one number, the plan\'s counted total', /^Needs you3things need you$/.test(text(m.card('needsyou-1'))), text(m.card('needsyou-1')));
      ok('M: up to three rows, each a tap-through', m.card('needsyou-2').querySelectorAll('[data-oshw-go]').length === 3, text(m.card('needsyou-2')));
      ok('L: the rows and "See your whole day"', /See your whole day/.test(text(m.card('needsyou-3'))));
      click(m.T.dom, m.card('needsyou-2').querySelector('[data-oshw-go="calls"]'));
      ok('a tap goes to that view', J(m.T.W.goTos) === J(['calls']), J(m.T.W.goTos));
      ok('every number on the card is a plan count', numbersIn(text(m.card('needsyou-2'))).every((n) => ['1', '3'].indexOf(n) !== -1), text(m.card('needsyou-2')));
      const e = await mount([{ id: 'needsyou', s: 'm' }], { plan: { total: 0, appointments: [], calls: [], promises: [], promised: [], estimates: [], money: [], stalled: [] } });
      ok('an empty plan: "Nothing needs you right now", no number', /Nothing needs you right now/.test(text(e.card('needsyou-1'))) && !/\d/.test(text(e.card('needsyou-1'))));
      const n = await mount([{ id: 'needsyou', s: 'm' }], { plan: null });
      ok('no plan yet: "Loading your day…", no number', /Loading your day/.test(text(n.card('needsyou-1'))) && !/\d/.test(text(n.card('needsyou-1'))));
    }

    console.log('\n4. Storm: Storm Center\'s cache, never a fake all-clear');
    {
      ok('stormNow: none / stale / clear / alert', HL.stormNow(null, NOW).state === 'none' && HL.stormNow({ ts: NOW - 3600000, data: [] }, NOW).state === 'stale'
        && HL.stormNow({ ts: NOW - 60000, data: [] }, NOW).state === 'clear' && J(HL.stormNow({ ts: NOW - 600000, data: [{ event: 'Hail' }, {}] }, NOW)) === J({ state: 'alert', n: 2, event: 'Hail', ageMin: 10 }));
      const items = [{ id: 'storm', s: 's' }, { id: 'storm', s: 'm' }];
      const a = await mount(items, { store: { nbd_storm_alerts_cache: JSON.stringify({ ts: NOW - 12 * 60000, data: [{ event: 'Severe Thunderstorm Warning' }, { event: 'Flood Watch' }] }) } });
      ok('an alert: today-plan stormLine\'s own line', /Severe Thunderstorm Warning \+1 more/.test(text(a.card('storm-1'))), text(a.card('storm-1')));
      ok('M: its age and Open Storm Center', /Cached 12 min ago/.test(text(a.card('storm-2'))) && !!a.card('storm-2').querySelector('[data-oshw-go="storm"]'));
      const none = await mount(items);
      ok('never cached: says Storm Center hasn\'t checked (not "no storms")', /hasn't checked yet/.test(text(none.card('storm-1'))) && !/\d/.test(text(none.card('storm-2'))));
      const stale = await mount(items, { store: { nbd_storm_alerts_cache: JSON.stringify({ ts: NOW - 2 * 3600000, data: [{ event: 'Hail' }] }) } });
      ok('an hour-old alert is not shown as current', /No storm check in the last hour/.test(text(stale.card('storm-1'))) && !/Hail/.test(text(stale.card('storm-2'))));
    }

    console.log('\n5. Closes this week: the CRM\'s own ranking, money only for a role that sees it');
    {
      const leads = [
        { id: 'A', firstName: 'Ann', lastName: 'Ash', stage: 'negotiating', jobValue: 12500, createdAt: NOW - 20 * 86400000, updatedAt: NOW - 86400000 },
        { id: 'B', firstName: 'Bo', lastName: '<i>Bee</i>', stage: 'estimate_sent', jobValue: 8000.5, createdAt: NOW - 9 * 86400000, updatedAt: NOW - 2 * 86400000 },
        { id: 'C', firstName: 'Cy', stage: 'closed', jobValue: 9000, createdAt: NOW - 9 * 86400000 },
        { id: 'D', firstName: 'Di', stage: 'new', createdAt: NOW - 86400000 },
      ];
      const c = await mount([{ id: 'closes', s: 'm' }, { id: 'closes', s: 'l' }], { leads, closes: true });
      const t = text(c.card('closes-1'));
      ok('lists the open deals with a value, best first (sold and no-value leads left out)', /2 open/.test(t) && t.indexOf('Ann Ash') < t.indexOf('Bo') && !/Cy|Di/.test(t), t);
      ok('projected value in cents through fmtCents ($12,500 and $8,000.50)', /\$12,500 projected/.test(t) && /\$8,000\.50 projected/.test(t), t);
      ok('no likelihood % on the card (a rule of thumb, not a count)', !/%/.test(t));
      ok('a name with markup arrives as text', !c.card('closes-1').querySelector('i'));
      ok('each row opens the customer', c.card('closes-1').querySelector('a.os-hw-row').getAttribute('href') === '/pro/customer.html?id=A');
      ok('L adds the reason and says it is a rule of thumb', /rule of thumb/.test(text(c.card('closes-2'))));
      const v = await mount([{ id: 'closes', s: 'm' }], { leads, closes: true, role: 'viewer' });
      ok('a viewer sees the deals but no dollar amounts', /Ann Ash/.test(text(v.card('closes-1'))) && !/\$/.test(text(v.card('closes-1'))), text(v.card('closes-1')));
      const w = await mount([{ id: 'closes', s: 'm' }], { leads, closes: false });
      ok('ranking not loaded yet: asks for the CRM\'s own closesweek bundle, shows no numbers', /Ranking your open deals/.test(text(w.card('closes-1')))
        && w.T.W.ScriptLoader.calls.indexOf('closesweek') !== -1 && !/\d/.test(text(w.card('closes-1'))), J(w.T.W.ScriptLoader.calls));
    }

    console.log('\n6. Money: the member\'s own, collected this month, in cents');
    {
      const nov = (d, amt) => ({ amount: amt, at: new Date(2026, 10, d).getTime() });
      const invs = [
        { id: 'i1', createdBy: 'u1', leadId: 'L1', total: 1000.10, balanceDue: 0, payments: [nov(2, 400.05), nov(5, 600.05)] },
        { id: 'i2', createdBy: 'u1', leadId: 'L2', total: 500, balanceDue: 0, payments: [{ amount: 500, at: new Date(2026, 9, 30).getTime() }] },
        { id: 'i3', createdBy: 'u2', leadId: 'L3', total: 9999, balanceDue: 0, payments: [nov(3, 9999)] },
      ];
      const m = await mount([{ id: 'money', s: 's' }, { id: 'money', s: 'm' }], { revenue: invs });
      ok('S: $1,000.10 collected in November (only this month, only u1\'s own)', /\$1,000\.10/.test(text(m.card('money-1'))) && /collected in November/.test(text(m.card('money-1'))), text(m.card('money-1')));
      ok('M: counts the payments (2)', /2 payments on your own invoices/.test(text(m.card('money-2'))), text(m.card('money-2')));
      ok('another rep\'s invoice never counts', !/9,999|10,999/.test(text(m.card('money-2'))));
      m.T.W.NBDRevenue.cached = () => null;   // a data refresh drops NBDRevenue's cache until the next load
      m.T.W.dispatchEvent(new m.T.W.CustomEvent('nbd:data-refreshed'));
      ok('after a refresh empties the cache, the last count stands with its time ("as of"), never a blank or a guess',
        /\$1,000\.10/.test(text(m.card('money-1'))) && /as of 1:05/.test(text(m.card('money-1'))), text(m.card('money-1')));
      const r = HL.moneyMonth(invs, 'u1', NOW, (list, a, b) => ({ total: list.length * 0.1 + 0.2, count: 1 }));
      ok('moneyMonth passes only the member\'s own invoices and returns whole cents', r && r.cents === 40 && Number.isInteger(r.cents), J(r));
      ok('moneyMonth with nothing loaded / no user -> null', HL.moneyMonth(null, 'u1', NOW, () => ({})) === null && HL.moneyMonth([], '', NOW, () => ({})) === null);
      const none = await mount([{ id: 'money', s: 'm' }], { revenue: [] });
      ok('no payments: a line with no amount (never "$0")', /No payments on your invoices yet in November/.test(text(none.card('money-1'))) && !/\$/.test(text(none.card('money-1'))));
      const wait = await mount([{ id: 'money', s: 's' }], { revenue: 'none' });
      ok('invoices not loaded: Checking payments…, no number', /Checking payments/.test(text(wait.card('money-1'))) && !/\d/.test(text(wait.card('money-1'))));
      const bad = await mount([{ id: 'money', s: 's' }], { revenue: 'none', revStatus: 'failed' });
      ok('a failed load says so, no number', /Couldn't load payments/.test(text(bad.card('money-1'))) && !/\d/.test(text(bad.card('money-1'))));
      ok('money is hidden on the lock screen', /html\.os-locked \.os-hw-money \{ visibility: hidden; \}/.test(HOME_CSS));
    }

    console.log('\n7. read cost, CSP, escaping, bundle');
    {
      const m = await mount([{ id: 'needsyou', s: 'l' }, { id: 'storm', s: 'm' }, { id: 'closes', s: 'l' }, { id: 'money', s: 'm' }], { closes: true, revenue: [] });
      m.T.W.dispatchEvent(new m.T.W.CustomEvent('nbd:data-refreshed'));
      m.T.W.dispatchEvent(new m.T.W.CustomEvent('nbd:invoices-loaded'));
      ok('read cost 0: no Firestore, callable or fetch; never compute()', m.T.reads.length === 0 && m.T.today.computeCalls === 0, J(m.T.reads));
      const code = noComments(P1_JS);
      ok('widgets-p1.js: no fetch, import(), Firestore, script injection or timers',
        !/\bfetch\s*\(|\bimport\s*\(|getDocs?\(|onSnapshot|createElement\(|setTimeout|setInterval/.test(code));
      ok('widgets-p1.js: no style="" and no el.style', !/style="|\.style\b/.test(code));
      ok('widgets-p1.js: its only loadBundle is the CRM\'s own closesweek', (code.match(/loadBundle\(/g) || []).length === 1 && /loadBundle\('closesweek'\)/.test(code));
      ok('widgets-p1.js builds markup through k.esc (no raw value between quotes)', !/' \+ (?!k\.esc\(|String\(|\(|'|title\(|goBtn\(|inner \+|bar|h\b)[a-zA-Z_.]+(?:\[[^\]]+\])? \+ '/.test(code),
        (code.match(/' \+ (?!k\.esc\(|String\(|\(|'|title\(|goBtn\(|inner \+|bar|h\b)[a-zA-Z_.]+(?:\[[^\]]+\])? \+ '/g) || []).slice(0, 4).join(' | '));
      ok('no new font size under 11px in home.css', (HOME_CSS.match(/font-size:\s*(\d+)px/g) || []).every((d) => Number(d.match(/\d+/)[0]) >= 11));
      ok('no motion of its own', !/@keyframes|animation:|transition:/.test(HOME_CSS));
      ok('home.js paints a P1 widget "Loading…" until its bundle lands (no fake number)', /Loading…<\/p>'/.test(HOME_JS));
    }
  } catch (e) { ok('section ran without throwing', false, e && e.stack); }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
