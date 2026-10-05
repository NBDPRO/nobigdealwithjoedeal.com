/**
 * tests/inbound-sms-convert.test.js — the pure lead-builder behind the
 * convertUnmatchedSms callable (functions/inbound-sms-convert-logic.js, shared
 * verbatim by the handler).
 *
 * Guards the invariants that matter for turning an untrusted inbound text into
 * a rules-compatible lead: the lead is always stamped with the converting
 * admin's userId/companyId (never null-tenant), phoneDigits is carried through
 * for inbound-SMS re-matching, the original text becomes the notes (clamped,
 * never unbounded), the lead lands in the canonical 'New' stage, and the
 * display name degrades safely to the last-4 digits.
 *
 * Zero deps (the logic module has no firebase imports).
 * Run: node tests/inbound-sms-convert.test.js
 */
'use strict';

const path = require('path');
const C = require(path.join('..', 'functions', 'inbound-sms-convert-logic.js'));

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

console.log('INBOUND-SMS CONVERT — lead builder');

// leadNameFromSms
{
  ok('name is last-4 of the digits', C.leadNameFromSms('5135551234') === 'Inbound SMS 1234');
  ok('strips non-digits before slicing', C.leadNameFromSms('+1 (513) 555-1234') === 'Inbound SMS 1234');
  ok('empty / null digits → bare label (never throws)',
    C.leadNameFromSms('') === 'Inbound SMS' && C.leadNameFromSms(null) === 'Inbound SMS' && C.leadNameFromSms(undefined) === 'Inbound SMS');
  ok('fewer than 4 digits → what there is', C.leadNameFromSms('12') === 'Inbound SMS 12');
}

// buildConvertedLead — tenant stamping + shape
{
  const lead = C.buildConvertedLead({
    from: '+15135551234', body: 'Hey, saw your truck — how much for a new roof?',
    phoneDigits: '5135551234', ownerUid: 'admin1', companyId: 'co1', unmatchedId: 'u1',
  });
  ok('stamps userId to the converting admin', lead.userId === 'admin1');
  ok('stamps companyId to the caller company', lead.companyId === 'co1');
  ok('carries phoneDigits for inbound-SMS re-matching', lead.phoneDigits === '5135551234');
  ok('keeps the raw phone', lead.phone === '+15135551234');
  ok('lands in the canonical first stage key + role (2026-10-04)', lead.stage === 'new' && lead.stageRole === 'new');
  ok('status new', lead.status === 'new');
  ok('source tags the origin', lead.source === 'Inbound SMS');
  ok('original text becomes the notes', lead.notes === 'Hey, saw your truck — how much for a new roof?');
  ok('records provenance', lead.convertedFromUnmatchedSms === 'u1');
  ok('name derived from the number', lead.firstName === 'Inbound SMS 1234');
}

// companyId fallback — a solo admin has companyId == uid
{
  const lead = C.buildConvertedLead({ from: '5551110000', body: 'hi', phoneDigits: '5551110000', ownerUid: 'solo', companyId: null, unmatchedId: 'u2' });
  ok('companyId falls back to ownerUid when absent (never null-tenant)', lead.companyId === 'solo');
}

// notes clamp — an abusive/huge body can't write an unbounded field
{
  const big = 'x'.repeat(5000);
  const lead = C.buildConvertedLead({ from: '1', body: big, phoneDigits: '', ownerUid: 'a', companyId: 'a', unmatchedId: 'u3' });
  ok('notes clamped to 2000 chars', lead.notes.length === 2000);
}

// null-safety — missing/garbage inputs never throw and never produce undefined tenant
{
  const lead = C.buildConvertedLead({});
  ok('empty input does not throw and yields a stable shape',
    lead.stage === 'new' && lead.notes === '' && lead.phone === '' && lead.phoneDigits === '');
  ok('null-ish body → empty notes', lead.notes === '');
}

console.log('\n──────────────────────────────');
console.log(`${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFailures:');
  fails.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
