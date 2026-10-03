/**
 * tests/invoice-reminder-2026-10-01.test.js
 *
 * One-tap overdue-invoice reminder (docs/pro/js/invoice-reminder.js), from
 * Jo's idea triage — built Jo's way: the rep sees and edits the message and
 * taps Send; nothing reaches a homeowner on its own. A Kentucky insurance job
 * inside its post-decision window is refused (no payment request yet).
 *
 * Run: node tests/invoice-reminder-2026-10-01.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const R = require(path.join(__dirname, '..', 'docs', 'pro', 'js', 'invoice-reminder.js'));
const K = require(path.join(__dirname, '..', 'docs', 'pro', 'js', 'ky-insurance-law.js'));
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

const NOW = new Date('2026-10-01T15:00:00Z');
const inv = (o) => Object.assign({ nbdInvoiceNumber: 'NBD-500-0042', total: 1450, balanceDue: 1450, dueDate: new Date('2026-09-15T12:00:00Z'), status: 'sent',
  customerName: 'Pat Q', customerPhone: '5135550142', customerEmail: 'pat@example.test', stripePaymentLink: 'https://buy.stripe.com/test_abc' }, o || {});
const ohLead = { firstName: 'Pat', address: '12 Main St, Milford, OH 45150', jobType: 'cash' };
const opts = (o) => Object.assign({ company: 'No Big Deal Home Solutions', repName: 'Joe', now: NOW, holdFn: (l, i, n) => K.payLinkHold(l, i, n) }, o || {});

console.log('\n1. the message');
{
  const r = R.buildReminder(inv(), ohLead, opts());
  ok('greets by first name, names the invoice, balance and due date, signs off', /^Hi Pat, a friendly reminder from No Big Deal Home Solutions: invoice NBD-500-0042 for \$1,450\.00 was due Sep 15\./.test(r.text) && /Thanks, Joe$/.test(r.text), r.text);
  ok('includes the pay link when one exists', /You can pay here: https:\/\/buy\.stripe\.com\/test_abc/.test(r.text));
  ok('no link on the invoice → "reply here" instead of a dangling "pay here:"', !/pay here/.test(R.buildReminder(inv({ stripePaymentLink: '' }), ohLead, opts()).text));
  ok('16 days overdue, allowed, recipients from the invoice', r.daysPastDue === 16 && r.allowed && r.to.phone === '5135550142' && r.to.email === 'pat@example.test');
  ok('uses the balance due, not the total, after a partial payment', /\$400\.00/.test(R.buildReminder(inv({ balanceDue: 400 }), ohLead, opts()).text));
}

console.log('\n2. when it must NOT go');
{
  const kyLead = { firstName: 'Kim', address: '9 Dixie Hwy, Florence, KY 41042', jobType: 'insurance', claimNumber: 'C-1' };
  const held = R.buildReminder(inv(), kyLead, opts());
  ok('a Kentucky insurance job with no carrier decision yet is HELD → not allowed, and no pay link in the text', held.held === true && held.allowed === false && !/stripe/.test(held.text));
  const released = R.buildReminder(inv(), Object.assign({}, kyLead, { carrierDecisionAt: '2026-08-01' }), opts());
  ok('…the same job after its window has run → allowed again', released.held === false && released.allowed === true);
  ok('paid, void or zero balance → not allowed', !R.buildReminder(inv({ status: 'paid' }), ohLead, opts()).allowed
    && !R.buildReminder(inv({ status: 'void' }), ohLead, opts()).allowed && !R.buildReminder(inv({ balanceDue: 0, total: 0 }), ohLead, opts()).allowed);
}

console.log('\n3. no nagging');
{
  const recent = R.buildReminder(inv({ lastReminderAt: new Date('2026-09-30T15:00:00Z'), reminderCount: 2 }), ohLead, opts());
  ok('reminded yesterday → tooSoon (the sheet warns, the rep can still send)', recent.tooSoon === true && recent.reminderCount === 2 && recent.allowed === true);
  ok('reminded 5 days ago → not too soon', R.buildReminder(inv({ lastReminderAt: { seconds: Date.parse('2026-09-26T15:00:00Z') / 1000 } }), ohLead, opts()).tooSoon === false);
}

console.log('\n4. wiring');
{
  const src = read('docs/pro/js/invoice-reminder.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/mg, '');
  // Behaviour, not shape (2026-10-03): the old check here only looked for
  // the text `if (r.held)`, which stayed green while open() looked the lead
  // up in _leads alone — a soft-deleted (filtered) or unloaded lead came back
  // null, payLinkHold(null, inv) said "not held", and a KY insurance invoice
  // inside its window got a payment request. section 5 drives open() for real.
  ok('every value in the sheet is escaped', !/\+ r\.text \+|\+ r\.to\.phone \+|\+ inv\.\w+ \+/.test(src) && /esc\(r\.text\)/.test(src));
  ok('the invoice records a reminder only on a real send (not the mail-app fallback, not an offline queue)',
    /delivered = e\.mode !== 'mailto';/.test(src) && /queued = s\.mode === 'queued'; delivered = !queued;/.test(src) && /if \(delivered\) \{[\s\S]{0,120}lastReminderAt: new Date\(\)/.test(src));
  ok('emails are transactional invoice mail (kind: invoice)', /kind: 'invoice'/.test(src));
  const md = read('docs/pro/js/money-dashboard.js');
  ok('the Collections queue offers Remind (data-action module → NBDInvoiceReminder.open) and shows "reminded Nd ago"',
    /data-target="NBDInvoiceReminder\.open"/.test(md) && /reminded ' \+ \(remDays === 0 \? 'today'/.test(md) && /lastReminderAt: inv\.lastReminderAt \|\| null/.test(md));
  ok('the money bundle loads it before money-dashboard', /'js\/invoice-reminder\.js\?v=\d+',\s*'js\/money-dashboard\.js\?v=\d+'/.test(read('docs/pro/js/script-loader.js')));
}
// open() for real, in a vm with a fake window: which invoices get a sheet.
async function openWith(o) {
  const vm = require('vm');
  const toasts = []; let sheets = 0; const tzSeen = [];
  const J = o.noJurisdiction ? undefined : Object.assign({}, K, {
    payLinkHold: (l, i, n, tz) => { tzSeen.push(tz); return K.payLinkHold(l, i, n, tz); },
  });
  const doc = {
    createElement: () => ({ setAttribute() {}, style: {}, addEventListener() {}, innerHTML: '', querySelectorAll: () => [] }),
    body: { appendChild() { sheets++; } },
    getElementById: () => null,
  };
  const win = {
    document: doc,
    showToast: (m, t) => toasts.push([String(m), t]),
    db: {}, doc: (_db, col, id) => ({ col, id }),
    getDoc: async (ref) => {
      if (ref.col === 'invoices') return { exists: () => true, data: () => o.invoice };
      if (ref.col === 'leads') {
        if (o.leadThrows) throw new Error('permission-denied');
        return { exists: () => !!o.leadDoc, data: () => o.leadDoc };
      }
      throw new Error('unexpected read ' + ref.col);
    },
    _leads: o.leads || [],
    NBDJurisdiction: J,
    _companyProfile: o.profile || {},
  };
  win.window = win;
  vm.runInNewContext(read('docs/pro/js/invoice-reminder.js'), { window: win, document: doc, console, Date, Math, JSON, Object, String, Number, Array, Promise, Intl });
  await win.NBDInvoiceReminder.open('inv_1');
  return { toasts, sheets, tzSeen };
}

(async () => {
  console.log('\n5. open() — the lead decides the Kentucky hold, and a lead it cannot read is refused (fail closed)');
  const kyIns = { firstName: 'Kim', address: '9 Dixie Hwy, Florence, KY 41042', jobType: 'insurance', claimNumber: 'C-1', deleted: true };
  const kyInv = inv({ leadId: 'lead_ky', dueDate: new Date(Date.now() - 20 * 86400000) });
  const a = await openWith({ invoice: kyInv, leads: [], leadDoc: kyIns });
  ok('KY insurance lead missing from _leads (soft-deleted) → the lead doc is read and the reminder is HELD, no sheet',
    a.sheets === 0 && a.toasts.length === 1 && /Kentucky insurance job/.test(a.toasts[0][0]), JSON.stringify(a));
  const b = await openWith({ invoice: kyInv, leads: [], leadThrows: true });
  ok('the lead doc cannot be read → refused (fail closed), no sheet', b.sheets === 0 && b.toasts.length === 1
    && b.toasts[0][1] === 'error' && /Kentucky payment rules can't be checked/.test(b.toasts[0][0]), JSON.stringify(b));
  const b2 = await openWith({ invoice: kyInv, leads: [], leadDoc: null });
  ok('the lead doc does not exist → refused (fail closed), no sheet', b2.sheets === 0 && b2.toasts.length === 1 && b2.toasts[0][1] === 'error', JSON.stringify(b2));
  const c = await openWith({ invoice: inv({ leadId: 'lead_oh', dueDate: new Date(Date.now() - 20 * 86400000) }), leads: [Object.assign({ id: 'lead_oh' }, ohLead)] });
  ok('…positive control: an Ohio cash lead in _leads → the sheet opens', c.sheets === 1 && c.toasts.length === 0, JSON.stringify(c));
  const d = await openWith({ invoice: inv({ leadId: 'lead_oh' }), leads: [Object.assign({ id: 'lead_oh' }, ohLead)], profile: { timezone: 'America/Chicago' } });
  ok('the tenant time zone reaches payLinkHold (as the server passes it)', d.tzSeen.length === 1 && d.tzSeen[0] === 'America/Chicago', JSON.stringify(d.tzSeen));
  const e = await openWith({ invoice: inv({ leadId: 'lead_oh' }), leads: [Object.assign({ id: 'lead_oh' }, ohLead)], noJurisdiction: true });
  ok('the jurisdiction module did not load → refused, no sheet', e.sheets === 0 && e.toasts.length === 1 && e.toasts[0][1] === 'error', JSON.stringify(e));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((err) => { console.error('invoice-reminder test crashed:', err && (err.stack || err.message)); process.exit(1); });
