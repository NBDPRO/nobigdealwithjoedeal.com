/**
 * tests/home-attention-yard-chip-2026-09-29.test.js
 *
 * The Home "needs you" strip (docs/pro/js/home-attention.js) and the customer
 * page's yard-sign chip (docs/pro/js/customer-yard-sign-chip.js). The strip
 * re-states two small rules from other modules, so the parity with those
 * modules is pinned here: the Stripe read rule (stripe-ledger-ui-logic.js
 * canRead) and "due" (yard-signs-logic.js statusOf). Synthetic data only.
 *
 * Run: node tests/home-attention-yard-chip-2026-09-29.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const HA = require(path.join(ROOT, 'docs', 'pro', 'js', 'home-attention.js'));
const YS = require(path.join(ROOT, 'docs', 'pro', 'js', 'yard-signs-logic.js'));
const SL = require(path.join(ROOT, 'docs', 'pro', 'js', 'stripe-ledger-ui-logic.js'));

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

console.log('\n1. who sees the Stripe count (same rule as the ledger panel)');
{
  const roles = ['', 'admin', 'company_admin', 'manager', 'sales_rep', 'viewer', 'owner'];
  const same = roles.every((r) => HA.canSeeStripe({ role: r, companyId: 'co' }, 'u1') === SL.canRead({ role: r, companyId: 'co' }, 'u1'));
  ok('every role agrees with stripe-ledger-ui-logic canRead', same);
  ok('signed out sees nothing', HA.canSeeStripe({}, null) === false && SL.canRead({}, null) === false);
  ok('tenant is the same as the panel\'s', HA.tenantOf({ companyId: 'co' }, 'u1') === SL.tenantOf({ companyId: 'co' }, 'u1') && HA.tenantOf({}, 'u1') === SL.tenantOf({}, 'u1'));
  ok('review count skips the platform\'s own subscription rows', HA.reviewCount([{ needsReview: true }, { needsReview: true, kind: 'platform_subscription' }, { needsReview: false }]) === 1);
}

console.log('\n2. which yard signs are "to pick up" (same as the Yard Signs view)');
{
  const now = new Date(2026, 8, 29, 10).getTime();
  const DAY = 86400000;
  const signs = [
    { status: 'out', dueAt: now - 3 * DAY },          // overdue
    { status: 'out', dueAt: now + 2 * 3600000 },      // due today
    { status: 'out', dueAt: now + 2 * DAY },          // due soon
    { status: 'out', dueAt: now + 10 * DAY },         // out
    { status: 'picked_up', dueAt: now - 5 * DAY },
    { status: 'missing', dueAt: now - 5 * DAY },
    { status: 'out', dueAt: { seconds: Math.floor((now - DAY) / 1000) } }, // Firestore Timestamp shape, overdue
  ];
  const viaView = signs.filter((s) => ['overdue', 'due_today'].includes(YS.statusOf(Object.assign({}, s, { dueAt: YS.ms(s.dueAt) }), now))).length;
  ok('overdue + due today = 3, matching statusOf', HA.signsDue(signs, now) === 3 && viaView === 3, 'strip=' + HA.signsDue(signs, now) + ' view=' + viaView);
  ok('nothing out → 0', HA.signsDue([], now) === 0 && HA.signsDue(null, now) === 0);
}

console.log('\n3. the strip');
{
  ok('both zero → empty (the strip hides)', HA.stripHtml({ stripe: 0, signs: 0 }) === '');
  const h = HA.stripHtml({ stripe: 1, signs: 2 });
  ok('singular / plural wording', /1 Stripe payment needs a customer/.test(h) && /2 yard signs to pick up/.test(h));
  ok('taps go through the existing goTo dispatcher to Money / Yard Signs', /data-action="goTo" data-target="money"/.test(h) && /data-action="goTo" data-target="signs"/.test(h));
  ok('only the Stripe item when there are no signs', HA.stripHtml({ stripe: 3, signs: 0 }).indexOf('yard') === -1);
}

console.log('\n4. wiring');
{
  const dash = fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'dashboard.html'), 'utf8');
  const cust = fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'customer.html'), 'utf8');
  const h0 = dash.indexOf('<template id="tpl-view-home">');
  const tplHome = dash.slice(h0, dash.indexOf('</template>', h0));
  ok('the Home view (tpl-view-home, the boot view) carries the hidden mount above the widgets',
    h0 > 0 && /id="homeAttention"[^>]*hidden[\s\S]*id="widgetGrid"/.test(tplHome) && (dash.match(/id="homeAttention"/g) || []).length === 1);
  ok('dashboard loads home-attention.js deferred', /<script defer src="js\/home-attention\.js\?v=\d+"><\/script>/.test(dash));
  const iLogic = cust.indexOf('js/yard-signs-logic.js'), iChip = cust.indexOf('js/customer-yard-sign-chip.js');
  ok('customer page loads the sign rules before the chip', iLogic > 0 && iChip > iLogic);
  const chip = strip(fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'js', 'customer-yard-sign-chip.js'), 'utf8'));
  ok('chip queries are scoped like yard-signs.js (owner or company) and narrowed by leadId',
    /where\('companyId', '==', c\.companyId\), window\.where\('leadId', '==', id\)/.test(chip) && /where\('userId', '==', u\), window\.where\('leadId', '==', id\)/.test(chip));
  ok('chip text is escaped', /esc\(st === 'missing'/.test(chip));
  const ha = strip(fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'js', 'home-attention.js'), 'utf8'));
  ok('no writes from the strip', !/\b(setDoc|addDoc|updateDoc|deleteDoc|httpsCallable)\b/.test(ha));
  ok('no inline handlers (CSP)', !/\son[a-z]+=/.test(ha) && !/\son[a-z]+=/.test(chip));
}

{
  // 📞 Calls that need you (2026-10-02). callNeedsYou is THE rule; the Call
  // Center's default tab delegates to it. On production the old rule flagged
  // 439 of 488 calls (every call without a customer) — the new one 49.
  console.log('\nCalls that need you');
  const NOW = Date.parse('2026-10-02T15:00:00Z');
  const H = 3600e3, D = 24 * H;
  const call = (x) => Object.assign({ startedAtMs: NOW - 2 * D, status: 'noted', leadId: 'L1', bucket: 'customer', promises: [] }, x);
  const need = (x) => HA.callNeedsYou(call(x), NOW);
  ok('a promise Jo made → needs you', need({ promises: [{ who: 'jo', text: 'send quote' }] }));
  ok('only THEIR promise → not', !need({ promises: [{ who: 'them', text: 'pay' }] }));
  ok('urgent → needs you', need({ urgent: true }));
  ok('follow-up date today or past → needs you', need({ followUpDate: '2026-10-02' }) && need({ followUpDate: '2026-09-30' }) && !need({ followUpDate: '2026-10-09' }));
  ok('a customer call with nothing owed → not', !need({}));
  ok('insurance line, no customer → needs you', need({ leadId: null, bucket: 'insurance' }));
  ok('unknown number, no customer → needs you (maybe a lead)', need({ leadId: null, bucket: 'unknown' }));
  ok('a MISSED (short) call from an unknown number → needs you; a short outgoing one → not', need({ leadId: null, bucket: 'unknown', status: 'short', direction: 'inbound' }) && !need({ leadId: null, bucket: 'unknown', status: 'short', direction: 'outbound' }));
  ok('a saved contact with no customer and no promise → not (the 223-call backlog)', !need({ leadId: null, bucket: 'contact' }));
  ok('…but with a promise Jo made → needs you', need({ leadId: null, bucket: 'contact', promises: [{ who: 'jo', text: 'x' }] }));
  ok('handled or personal → never', !need({ handledAtMs: NOW, urgent: true }) && !need({ status: 'personal', urgent: true }));
  ok('older than 14 days → never (backlog)', !need({ startedAtMs: NOW - 15 * D, urgent: true, promises: [{ who: 'jo', text: 'x' }] }) && need({ startedAtMs: NOW - 13 * D, promises: [{ who: 'jo', text: 'x' }] }));
  ok('count helper', HA.callsNeedingYou([call({ urgent: true }), call({}), call({ leadId: null, bucket: 'unknown' })], NOW) === 2);
  ok('strip shows the calls item, singular and plural, to the Call Center', /data-target="calls">📞 1 call needs you</.test(HA.stripHtml({ calls: 1 })) && /📞 49 calls need you/.test(HA.stripHtml({ calls: 49 })) && HA.stripHtml({ calls: 0 }) === '');
  const ccv = fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'js', 'call-center-view.js'), 'utf8');
  ok('the Call Center view delegates to the same rule', /NBDHomeAttention\.callNeedsYou\(c, Date\.now\(\)\)/.test(ccv));
  const haSrc = fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'js', 'home-attention.js'), 'utf8');
  ok('Home reads only the owner\'s own calls, newest 200', /collection\(w\.db, 'phone_calls'\), w\.where\('userId', '==', u\), w\.orderBy\('startedAtMs', 'desc'\), w\.limit\(200\)/.test(haSrc));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
