/**
 * tests/text-inbox-logic-2026-10-01.test.js — the SMS Backup & Restore
 * parser and sorting behind the Text Inbox (functions/text-inbox-logic.js).
 * The XML below is shaped like the app's real output; names and numbers
 * are invented (555).
 *
 * Run: node tests/text-inbox-logic-2026-10-01.test.js
 */
'use strict';

const path = require('path');
const T = require(path.join(__dirname, '..', 'functions', 'text-inbox-logic.js'));

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

const XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<smses count="9" backup_set="x" backup_date="1727900000000" type="full">
  <sms protocol="0" address="+15135550100" date="1727800000000" type="1" subject="null" body="Can you come Tuesday? &amp; bring samples &#128512;" toa="null" sc_toa="null" service_center="null" read="1" status="-1" locked="0" date_sent="1727800000000" sub_id="1" readable_date="Oct 1, 2024 12:26:40 PM" contact_name="Pat Example" />
  <sms protocol="0" address="(513) 555-0100" date="1727800600000" type="2" subject="null" body="Yes, 10am. I&apos;ll send the quote tonight." read="1" status="-1" contact_name="Pat Example" />
  <sms protocol="0" address="+18005550111" date="1727800700000" type="1" body="&quot;Claim&quot; update &lt;ref 12&gt;" contact_name="(Unknown)" />
  <sms protocol="0" address="72975" date="1727800800000" type="1" body="Your code is 123456" contact_name="(Unknown)" />
  <sms protocol="0" address="+15135550100" date="1727800900000" type="3" body="draft" contact_name="Pat Example" />
  <sms protocol="0" address="+15135550100" date="1600000000000" type="1" body="old" contact_name="Pat Example" />
  <mms date="1727801000" msg_box="1" address="+15135550100" contact_name="Pat Example" m_type="132">
    <parts>
      <part seq="-1" ct="application/smil" text="null" />
      <part seq="0" ct="image/jpeg" name="IMG.jpg" data="AAAA" />
      <part seq="1" ct="text/plain" text="Here is the leak" />
    </parts>
    <addrs><addr address="+15135550100" type="137" charset="106" /></addrs>
  </mms>
  <mms date="1727801100" msg_box="2" address="+15135550100~+15135550199" contact_name="Pat Example, Sam Example" m_type="128">
    <parts><part seq="0" ct="text/plain" text="Group: see you both at 10" /></parts>
  </mms>
  <mms date="1727801200" msg_box="1" address="227898" contact_name="(Unknown)">
    <parts><part seq="0" ct="text/plain" text="Delivery update" /></parts>
  </mms>
</smses>`;

console.log('\n1. Parser');
const { messages, skipped } = T.parseSmsBackup(XML, { sinceMs: 1727000000000 });
ok('5 real messages kept, in time order', messages.length === 5 && messages.every((m, i) => !i || m.dateMs >= messages[i - 1].dateMs), String(messages.length));
const [inb, out, claim, mmsIn, group] = messages;
ok('received sms: direction, digits, name, entities decoded', inb.direction === 'inbound' && inb.phoneDigits === '5135550100' && inb.contactName === 'Pat Example' && inb.body === 'Can you come Tuesday? & bring samples 😀');
ok('sent sms: outbound, apostrophe decoded, formatted address normalised', out.direction === 'outbound' && out.body === "Yes, 10am. I'll send the quote tonight." && out.phoneDigits === '5135550100');
ok('"(Unknown)" contact → empty name; quotes and brackets decoded', claim.contactName === '' && claim.body === '"Claim" update <ref 12>');
ok('mms: date in seconds → ms, text part kept, photo counted', mmsIn.kind === 'mms' && mmsIn.dateMs === 1727801000000 && mmsIn.body === 'Here is the leak\n[1 photo]' && mmsIn.direction === 'inbound');
ok('group mms flagged, first number used', group.group === true && group.phoneDigits === '5135550100' && group.direction === 'outbound');
ok('short codes never kept (2FA, alerts) — sms and mms', skipped.shortCode === 2 && !messages.some((m) => /code is|Delivery/.test(m.body)));
ok('drafts skipped, old ones skipped', skipped.otherType === 1 && skipped.old === 1);
ok('empty / garbage input → nothing', T.parseSmsBackup('').messages.length === 0 && T.parseSmsBackup('<html>').messages.length === 0);

console.log('\n2. Helpers');
ok('short-code detection', T.isShortCode('72975') && T.isShortCode('227898') && !T.isShortCode('+15135550100') && !T.isShortCode(''));
ok('doc id is stable for the same text', T.textDocId(inb) === T.textDocId(Object.assign({}, inb)) && /^sms_[0-9a-f]{28}$/.test(T.textDocId(inb)));
ok('doc id differs for a different text', T.textDocId(inb) !== T.textDocId(out));
const files = [{ name: 'calls-20261001120000.xml' }, { name: 'sms-20260930120000.xml' }, { name: 'sms-20261001120000.xml' }, { name: 'notes.txt' }];
ok('newest sms backup picked, call-log backups ignored', T.pickNewestBackup(files).name === 'sms-20261001120000.xml');
ok('no backups → null', T.pickNewestBackup([{ name: 'calls-20261001120000.xml' }]) === null);
const NOW = Date.parse('2026-10-01T12:00:00Z');
ok('first run reads 90 days', T.sinceFor(null, NOW, 90) === NOW - 90 * 864e5);
ok('later runs overlap the cursor by 3 days', T.sinceFor(NOW - 864e5, NOW, 90) === NOW - 4 * 864e5);
const doc = T.buildTextDoc({ ownerUid: 'U', msg: inb, match: { leadId: 'L1', alternates: [] }, bucket: 'customer', fileId: 'F', nowMs: 1 });
ok('text doc is tenant-stamped and matched', doc.userId === 'U' && doc.companyId === 'U' && doc.leadId === 'L1' && doc.sentAtMs === inb.dateMs && doc.bucket === 'customer');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
