#!/usr/bin/env node
/*
 * build-demo-seed.js — writes docs/pro/demo-sdk/sample-company.json, the seed
 * for the browser-only sample account (Pro demo phase 2, wave 1, 2026-10-06).
 *
 * The company, owner, story customer, carrier, roof and tier prices come from
 * the SAME `SAMPLE` object the guided story uses (docs/pro/js/sandbox-story.js),
 * read straight out of that file, so the story and the account never disagree.
 * Everything else here is invented: names, street names (Sample / Example /
 * Placeholder streets), 555-01xx phone numbers, @example.com emails.
 *
 * Retail prices only. No cost, margin or contractor fields — the seed ships
 * under docs/, so tests/catalog-cost-privacy.test.js applies to it.
 * Kentucky insurance jobs carry no deposit or "due at signing" amount.
 *
 * Dates are RELATIVE ({"__ts": {"days": -3}} etc.) and resolved in the browser
 * by docs/pro/demo-sdk/_store.js, so "today", "overdue" and "this week" always
 * look current.
 *
 * Wave 1 seeds what the dashboard and customer card read: the company, the
 * owner, a subscription, ~25 leads across the pipeline, tasks, notes and
 * estimates. Wave 2 adds the brand, business rules, line items and photos.
 * Wave 3 adds the door-knocking map and Storm Center (knocks on the houses of
 * docs/pro/demo-sdk/basemap.js's invented neighbourhood, the story's hail
 * swath as a territory + Storm Center zone, sample storm reports and one
 * sample alert, all under "offline") and the Agent inbox (bot drafts).
 * Later: invoices.
 *
 *   node scripts/build-demo-seed.js          write the file
 *   node scripts/build-demo-seed.js --check  exit 1 if the file is stale
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const STORY = path.join(ROOT, 'docs', 'pro', 'js', 'sandbox-story.js');
const OUT = path.join(ROOT, 'docs', 'pro', 'demo-sdk', 'sample-company.json');
const SEED_VERSION = 3; // 2 = wave 2 (brand, business rules, line items, photos); 3 = wave 3 (D2D, storm, Agent inbox)
const BASEMAP = path.join(ROOT, 'docs', 'pro', 'demo-sdk', 'basemap.js');
const UID = 'demo-owner';

function readSample() {
  const src = fs.readFileSync(STORY, 'utf8');
  const m = /var SAMPLE = (\{[\s\S]*?\n {2}\});/.exec(src);
  if (!m) throw new Error('build-demo-seed: could not find `var SAMPLE = {...};` in sandbox-story.js');
  return vm.runInNewContext('(' + m[1] + ')', Object.create(null), { timeout: 1000 });
}

const ts = (days, hour) => ({ __ts: { days, hour: hour == null ? 10 : hour } });
const date = (days) => ({ __date: { days } });
const digits = (p) => String(p).replace(/\D/g, '').replace(/^1/, '').slice(-10);

function build() {
  const S = readSample();
  const owner = 'Sam Sample';
  const [storyStreet] = [S.street];
  const cityParts = /^(.*), ([A-Z]{2}) (\d{5})$/.exec(S.cityLine);
  const preferred = S.tiers.find((t) => t.key === 'better') || S.tiers[1];

  // [first, last, street, city, state, zip, stage, jobType, damage, source, carrier, jobValue$, createdDaysAgo, followUpDays|null, lat, lng, note]
  const ROWS = [
    ['Jordan', 'Avery', storyStreet, cityParts[1], cityParts[2], cityParts[3], 'estimate_submitted', 'insurance', 'Roof - Hail', 'door_knock', S.carrier, preferred.priceCents / 100, 9, 1, 39.0751, -84.4466,
      `Door knock in ${S.zone} after the storm. ${S.squares} squares, ${S.pitch} pitch. Hail bruising on the north and west slopes. Three options sent; homeowner deciding before the carrier decision date.`],
    ['Maya', 'Brooks', '37 Example Hollow Ln', 'Florence', 'KY', '41042', 'new', 'insurance', 'Roof - Hail', 'storm_alert', 'Sample Mutual Insurance', 0, 1, 0, 38.9989, -84.6266, 'Storm alert lead. Wants someone to look before calling the carrier.'],
    ['Devon', 'Price', '905 Placeholder Pike', 'Mason', 'OH', '45040', 'new', 'cash', 'Roof - Age', 'website', '', 0, 0, 1, 39.3601, -84.3099, 'Website form: 22-year-old roof, a few shingles in the yard after the wind.'],
    ['Rita', 'Okafor', '12 Sample Orchard Dr', 'Union', 'KY', '41091', 'new', 'insurance', 'Roof - Wind', 'door_knock', 'Example Home & Auto', 0, 2, -1, 38.9459, -84.6805, 'Missing ridge caps on the back. Not home on the first knock; left a door hanger.'],
    ['Glen', 'Hartley', '480 Example Meadow Rd', 'Loveland', 'OH', '45140', 'contacted', 'cash', 'Gutters', 'referral', '', 0, 6, 2, 39.2689, -84.2638, 'Referred by a past sample customer. Gutters pulling away on the front.'],
    ['Priya', 'Nair', '2210 Placeholder Ave', 'Fort Mitchell', 'KY', '41017', 'contacted', 'insurance', 'Roof - Hail', 'storm_alert', 'Sample Mutual Insurance', 0, 5, 0, 39.0595, -84.5474, 'Called back after the storm alert text. Inspection to book this week.'],
    ['Owen', 'Castillo', '66 Sample Creek Ct', 'Milford', 'OH', '45150', 'inspected', 'insurance', 'Roof - Hail', 'door_knock', 'Example Home & Auto', 15800, 12, 1, 39.1753, -84.2944, 'Inspection done: hail on all slopes, two cracked vent boots. Photo report sent.'],
    ['Hannah', 'Wolfe', '318 Example Ridge Way', 'Independence', 'KY', '41051', 'inspected', 'cash', 'Roof - Age', 'website', '', 13900, 10, 3, 38.9431, -84.5441, 'Original 3-tab, curling. Wants Preferred pricing and a start date before winter.'],
    ['Marcus', 'Feld', '1501 Placeholder Rd', 'Batavia', 'OH', '45103', 'claim_filed', 'insurance', 'Roof - Hail', 'door_knock', 'Sample Mutual Insurance', 18900, 18, 2, 39.0770, -84.1769, 'Claim filed. Waiting on the adjuster to call with a date.'],
    ['Lena', 'Ortiz', '77 Sample Bluff Rd', 'Covington', 'KY', '41011', 'adjuster_meeting_scheduled', 'insurance', 'Roof - Wind', 'referral', 'Example Home & Auto', 16400, 16, 4, 39.0837, -84.5086, 'Adjuster meeting set. Bring the photo report and the ladder.'],
    ['Theo', 'Barnes', '940 Example Point Dr', 'West Chester', 'OH', '45069', 'scope_received', 'insurance', 'Roof - Hail', 'storm_alert', 'Sample Mutual Insurance', 21300, 24, 1, 39.3328, -84.4083, 'Scope in. Two line items missing (starter, drip edge): supplement to write.'],
    ['Nadia', 'Kerr', '25 Placeholder Ln', 'Erlanger', 'KY', '41018', 'supplement_requested', 'insurance', 'Roof - Hail', 'door_knock', 'Sample Mutual Insurance', 19650, 30, 3, 39.0167, -84.6008, 'Supplement sent for ice and water at the valleys. Follow up Thursday.'],
    ['Caleb', 'Ross', '612 Sample Valley Rd', 'Anderson Township', 'OH', '45244', 'estimate_sent_cash', 'cash', 'Roof - Age', 'website', '', 14300, 8, 2, 39.0851, -84.3516, 'Retail estimate sent: Standard, Preferred, Elite. Leaning Preferred.'],
    ['Ivy', 'Chen', '19 Example Grove Ct', 'Burlington', 'KY', '41005', 'negotiating', 'cash', 'Siding', 'referral', '', 11200, 14, 0, 39.0276, -84.7241, 'Siding on two elevations. Asked about financing; sent the monthly options.'],
    ['Ruben', 'Diaz', '233 Placeholder Blvd', 'Fairfield', 'OH', '45014', 'prequal_sent', 'finance', 'Roof - Age', 'website', '', 16100, 11, 2, 39.3454, -84.5603, 'Financing pre-qualification link sent.'],
    ['Grace', 'Holm', '81 Sample Terrace', 'Fort Wright', 'KY', '41011', 'contract_signed', 'insurance', 'Roof - Hail', 'door_knock', 'Example Home & Auto', 20400, 34, 3, 39.0517, -84.5341, 'Signed. Kentucky insurance job: nothing collected at signing; deductible after the carrier decision.'],
    ['Ezra', 'Lane', '402 Example Hill Rd', 'Blue Ash', 'OH', '45242', 'materials_ordered', 'cash', 'Roof - Age', 'referral', '', 17600, 40, 2, 39.2320, -84.3783, 'Materials ordered for delivery Tuesday. Preferred, Charcoal.'],
    ['Sofia', 'Marsh', '57 Sample Lake Dr', 'Hebron', 'KY', '41048', 'crew_scheduled', 'insurance', 'Roof - Hail', 'storm_alert', 'Sample Mutual Insurance', 18200, 45, 4, 39.0659, -84.7010, 'Crew scheduled. Weather looks clear; dumpster drop the day before.'],
    ['Ben', 'Albright', '1180 Placeholder Way', 'Montgomery', 'OH', '45242', 'install_in_progress', 'cash', 'Roof - Age', 'website', '', 15400, 50, 0, 39.2281, -84.3541, 'Tear-off day one done. Two sheets of decking replaced, photos logged.'],
    ['Clara', 'Voss', '344 Example Bend', 'Alexandria', 'KY', '41001', 'install_complete', 'insurance', 'Roof - Wind', 'door_knock', 'Example Home & Auto', 14900, 58, 1, 38.9595, -84.3880, 'Install complete. Final photos and the completion certificate to send.'],
    ['Felix', 'Grant', '15 Sample Commons', 'Lebanon', 'OH', '45036', 'final_payment', 'cash', 'Roof - Age', 'referral', '', 13800, 66, 2, 39.4353, -84.2030, 'Final invoice sent. Half paid at start, balance due on completion.'],
    ['June', 'Park', '700 Placeholder Ct', 'Edgewood', 'KY', '41017', 'closed', 'insurance', 'Roof - Hail', 'storm_alert', 'Sample Mutual Insurance', 19100, 90, null, 39.0187, -84.5777, 'Paid in full. Review request and warranty registration done.'],
    ['Arlo', 'Hughes', '29 Example Square', 'Loveland', 'OH', '45140', 'closed', 'cash', 'Gutters', 'website', '', 3200, 75, null, 39.2706, -84.2719, 'Seamless gutters and guards. Paid in full.'],
    ['Wes', 'Tran', '1312 Sample Pass', 'Cold Spring', 'KY', '41076', 'lost', 'insurance', 'Roof - Hail', 'door_knock', 'Example Home & Auto', 17800, 38, null, 39.0137, -84.4380, 'Went with another contractor after the scope came in.'],
    ['Nora', 'Quinn', '88 Placeholder Hollow', 'Milford', 'OH', '45150', 'service_quoted', 'cash', 'Repair', 'referral', '', 650, 3, 1, 39.1762, -84.2901, 'Leak at the chimney flashing. Repair quoted.']
  ];

  const docs = {};
  const add = (p, d) => { if (docs[p]) throw new Error('duplicate seed path ' + p); docs[p] = d; };

  add('users/' + UID, {
    uid: UID, email: 'owner@sample-roofing.example', displayName: owner, role: 'company_admin',
    companyId: UID, company: S.company, phone: '(859) 555-0100', calcomUsername: '', calcomEventSlug: 'roof-inspection',
    isSample: true, createdAt: ts(-120)
  });
  add('subscriptions/' + UID, { plan: 'growth', status: 'active', isSample: true, currentPeriodEnd: ts(25) });
  add('companies/' + UID, {
    name: S.company, ownerId: UID, ownerUid: UID, plan: 'growth', seatLimit: 5, isSample: true, createdAt: ts(-120)
  });
  add('companies/' + UID + '/members/' + UID, { uid: UID, role: 'company_admin', displayName: owner, email: 'owner@sample-roofing.example', status: 'active', joinedAt: ts(-120) });
  add('companyProfile/' + UID, {
    companyName: S.company, companyId: UID, ownerName: owner, phone: '(859) 555-0100', email: 'office@sample-roofing.example',
    address: '100 Sample Way, Fort Thomas, KY 41075', serviceStates: ['KY', 'OH'], website: '', docPrefix: 'SMP',
    displayName: S.company, legalName: S.company + ' (sample)',
    contact: { phone: '(859) 555-0100', email: 'office@sample-roofing.example', address: '100 Sample Way, Fort Thomas, KY 41075' },
    // The new-owner setup checklist is for a real account; the sample one
    // opens straight onto its work.
    setupChecklist: { hidden: true },
    // Wave 2 (2026-10-06): the sample company's OWN brand. Without it the
    // profile deep-merges NBD's defaults and every generated document would
    // wear NBD's name, phone and GAF/TAMKO numbers (company-profile.js
    // _isNbdBrand). No logo, no credential badges: a sample company has none.
    brand: {
      legalName: S.company, displayName: S.company, tagline: '', logoUrl: '', affiliates: [],
      contact: {
        phone: '(859) 555-0100', email: 'office@sample-roofing.example', website: '',
        address: '100 Sample Way, Fort Thomas, KY 41075', mailingAddress: '100 Sample Way, Fort Thomas, KY 41075',
        alertEmail: '', alertSms: ''
      }
    },
    businessAddress: '100 Sample Way, Fort Thomas, KY 41075',
    // The story's three packages, through the real per-company rules
    // (tenant-rules.js): GAF System Plus on Standard and up, every price
    // marked as a sample. Deposit: the same 50%-at-$2,000 cash rule NBD uses,
    // so a retail job shows its deposit; Kentucky insurance jobs still take
    // nothing at signing (deposit-rule.js keys that to the property's state,
    // which no company setting can switch off).
    businessRules: {
      tiers: {
        enabled: S.tiers.map((t) => t.key),
        labels: Object.fromEntries(S.tiers.map((t) => [t.key, t.label])),
        notes: Object.fromEntries(S.tiers.map((t) => [t.key, t.shingle + ' · System Plus · sample price'])),
        warranty: Object.fromEntries(S.tiers.map((t) => [t.key, S.systemPlus + ' on the ' + t.label + ' package (sample). Workmanship warranty terms are as stated in your written agreement.']))
      },
      deposit: { noDepositUnderCents: 200000, depositPct: 50, roundToCents: 2500 }
    },
    // Per-square package prices = the story's prices over its 26 squares.
    pricing: { addonPrices: {}, tierRates: Object.fromEntries(S.tiers.map((t) => [t.key, Math.round(t.priceCents / 100 / S.squares)])) },
    isSample: true, updatedAt: ts(-30)
  });

  ROWS.forEach((r, i) => {
    const [first, last, street, city, state, zip, stage, jobType, damage, source, carrier, value, ago, fu, lat, lng, note] = r;
    const id = 'sample-lead-' + String(i + 1).padStart(2, '0');
    const area = state === 'KY' ? '859' : '513';
    const phone = '(' + area + ') 555-01' + String(10 + i).padStart(2, '0');
    const lead = {
      firstName: first, lastName: last, name: first + ' ' + last,
      address: street + ', ' + city + ', ' + state + ' ' + zip,
      city, state, zip, lat, lng,
      phone, phoneDigits: digits(phone), email: first.toLowerCase() + '.' + last.toLowerCase() + '@example.com',
      stage, jobType, damageType: damage, source, jobValue: value,
      userId: UID, companyId: UID, deleted: false, isSample: true,
      customerId: 'SMP-' + String(1001 + i),
      createdAt: ts(-ago, 9 + (i % 7)), updatedAt: ts(-Math.max(0, Math.min(ago, 2)), 11), stageStartedAt: ts(-Math.min(ago, 3), 12),
      notes: note
    };
    if (fu !== null) lead.followUp = date(fu);
    if (carrier) { lead.insuranceCarrier = carrier; lead.insCarrier = carrier; lead.claimNumber = 'SAMPLE-' + (4100 + i); }
    if (stage === 'lost') { lead.lostReason = 'Went with someone else'; lead.lostReasonKey = 'competitor'; lead.lostAt = ts(-6); }
    if (i === 0) {
      lead.deductible = S.deductible; lead.squares = S.squares; lead.pitch = S.pitch;
      lead.carrierDecisionDate = S.decisionDate; lead.stormZone = S.zone; lead.hailHit = true;
      // Wave 2: the contract's "Description of Work" reads lead.scopeOfWork.
      lead.scopeOfWork = 'Tear off the existing shingles to the deck and install a new ' + preferred.shingle + ' roof system (' +
        preferred.label + ' package) on ' + S.squares + ' squares at ' + S.pitch + ' pitch: ' + preferred.items.join(', ').toLowerCase() + '.';
    }
    add('leads/' + id, lead);
    add('notes/sample-note-' + String(i + 1).padStart(2, '0'), {
      leadId: id, userId: UID, companyId: UID, text: note, type: 'note', author: owner, isSample: true, createdAt: ts(-Math.min(ago, 5), 15)
    });
  });

  // Tasks on the leads that need a next step (leads/{id}/tasks, like tasks.js writes).
  const TASKS = [
    [1, 'Call Jordan about the three roof options', 0], [1, 'Check the carrier decision date', 3],
    [2, 'Book the inspection', 0], [6, 'Book the inspection', 1], [9, 'Call the adjuster for a meeting date', -1],
    [11, 'Write the supplement: starter and drip edge', 0], [12, 'Follow up on the supplement', 2],
    [16, 'Send the materials order', 1], [18, 'Confirm the dumpster drop', 3], [21, 'Send the completion certificate', 0]
  ];
  TASKS.forEach(([n, text, due], k) => {
    const leadId = 'sample-lead-' + String(n).padStart(2, '0');
    add('leads/' + leadId + '/tasks/sample-task-' + String(k + 1).padStart(2, '0'), {
      leadId, userId: UID, companyId: UID, text, done: false, dueDate: date(due), isSample: true, createdAt: ts(-2, 9)
    });
  });

  // Estimates: the story's good/better/best on Jordan Avery, plus three more.
  const tiersOut = S.tiers.map((t) => ({ key: t.key, label: t.label, product: t.shingle, total: t.priceCents / 100, includes: t.items.slice() }));
  add('estimates/sample-est-01', {
    leadId: 'sample-lead-01', userId: UID, companyId: UID, isSample: true,
    owner: 'Jordan Avery', address: S.street + ', ' + S.cityLine, name: 'Roof replacement: three options',
    package: 'Better', selectedTier: 'better', total: preferred.priceCents / 100, grandTotal: preferred.priceCents / 100,
    squares: S.squares, pitch: S.pitch, tiers: tiersOut, warrantyNote: S.systemPlus + ' (Standard and up)',
    status: 'sent', createdAt: ts(-2, 14), updatedAt: ts(-2, 14)
  });
  [[7, 15800, 'Better'], [13, 14300, 'Better'], [16, 20400, 'Best']].forEach(([n, total, pkg], k) => {
    const L = ROWS[n - 1];
    add('estimates/sample-est-0' + (k + 2), {
      leadId: 'sample-lead-' + String(n).padStart(2, '0'), userId: UID, companyId: UID, isSample: true,
      owner: L[0] + ' ' + L[1], address: L[2] + ', ' + L[3] + ', ' + L[4] + ' ' + L[5], name: 'Roof replacement',
      package: pkg, total, grandTotal: total, status: n === 16 ? 'accepted' : 'sent', createdAt: ts(-5 - k, 13), updatedAt: ts(-4 - k, 13),
      tier: pkg.toLowerCase(), lineItems: [{ description: 'Roof replacement, ' + pkg + ' package (sample price)', qty: 1, unit: 'job', rate: total, total }]
    });
  });

  // Wave 2: Jordan's estimate carries its scope as classic line items (retail
  // only) so the contract / proposal generators fill from it, like a real
  // saved estimate does (doc-preflight.js mapEstimateLineItems).
  Object.assign(docs['estimates/sample-est-01'], {
    tier: preferred.key, mode: 'insurance',
    lineItems: [{
      description: 'Roof replacement, ' + preferred.label + ' package: ' + preferred.shingle + ', ' + preferred.items.join(', ').toLowerCase() + ' (sample price)',
      qty: S.squares, unit: 'SQ', rate: Math.round(preferred.priceCents / 100 / S.squares), total: preferred.priceCents / 100
    }]
  });
  docs['leads/sample-lead-01'].primaryEstimateId = 'sample-est-01';

  // Wave 2: sample job photos. Simple drawings committed under
  // docs/pro/demo-sdk/media/ (no real customer photo, no camera metadata,
  // nothing fetched from another site). {"__media": file} resolves to this
  // origin's URL in the browser (_store.js), because the CRM only renders
  // photo URLs that are absolute.
  const PHOTOS = [
    [1, 'roof-front.svg', 'Before', 'Property', '', '', 'Front elevation', 'Front of the house before work'],
    [1, 'hail-hits.svg', 'Before', 'Damage', 'Hail', '3', 'North slope', 'Hail bruising on the north slope, marked in chalk'],
    [1, 'test-square.svg', 'Before', 'Damage', 'Hail', '3', 'West slope', 'Ten-by-ten test square, west slope'],
    [1, 'vent-boot.svg', 'Before', 'Damage', 'Hail', '2', 'Rear slope', 'Cracked pipe boot on the rear slope'],
    [1, 'gutter-dent.svg', 'Before', 'Damage', 'Hail', '1', 'Front gutter', 'Dented gutter and downspout'],
    [7, 'roof-front.svg', 'Before', 'Property', '', '', 'Front elevation', 'Front of the house'],
    [7, 'hail-hits.svg', 'Before', 'Damage', 'Hail', '3', 'All slopes', 'Hail on all slopes'],
    [7, 'vent-boot.svg', 'Before', 'Damage', 'Hail', '2', 'Rear slope', 'Two cracked vent boots'],
    [4, 'ridge-cap.svg', 'Before', 'Damage', 'Wind', '2', 'Back ridge', 'Missing ridge caps on the back'],
    [20, 'roof-front.svg', 'Before', 'Property', '', '', 'Front elevation', 'Before the new roof'],
    [20, 'roof-after.svg', 'After', 'Completed', '', '', 'Front elevation', 'New roof, install complete']
  ];
  PHOTOS.forEach(([n, file, phase, category, damage, sev, where, caption], k) => {
    const leadId = 'sample-lead-' + String(n).padStart(2, '0');
    const when = ts(-Math.min(ROWS[n - 1][12], 6) + (phase === 'After' ? 5 : 0), 11);
    add('photos/sample-photo-' + String(k + 1).padStart(2, '0'), {
      leadId, userId: UID, companyId: UID, isSample: true,
      url: { __media: file }, storagePath: 'sample/' + file, filename: file, type: 'image/svg+xml',
      phase, category, damageType: damage, severity: sev, location: where,
      caption: caption + ' (sample drawing)', createdAt: when, date: when, uploadedAt: when
    });
  });

  const offline = addWave3({ S, ROWS, docs, add, owner });

  return {
    '//': 'GENERATED by scripts/build-demo-seed.js from docs/pro/js/sandbox-story.js SAMPLE. Do not edit by hand; run `node scripts/build-demo-seed.js`. All people, streets, phones and emails are invented. Retail prices only.',
    version: SEED_VERSION,
    company: { name: S.company, bot: S.bot },
    user: { uid: UID, email: 'owner@sample-roofing.example', displayName: owner },
    claims: { companyId: UID, role: 'company_admin' },
    offline,
    docs
  };
}

// ── Wave 3: the door-knocking map, Storm Center and the Agent inbox ──────
function readBasemap() {
  const ctx = Object.create(null);
  ctx.window = ctx;
  vm.runInNewContext(fs.readFileSync(BASEMAP, 'utf8'), ctx, { timeout: 2000 });
  if (!ctx.NBD_DEMO_BASEMAP) throw new Error('build-demo-seed: basemap.js did not define NBD_DEMO_BASEMAP');
  return ctx.NBD_DEMO_BASEMAP;
}
function readStoryDraft() {
  const m = /var DRAFT = '([^'\n]*)';/.exec(fs.readFileSync(STORY, 'utf8'));
  if (!m) throw new Error('build-demo-seed: could not find `var DRAFT = \'...\';` in sandbox-story.js');
  return m[1];
}
// Deterministic 0..1 from a string (FNV-1a), so the seed never changes between runs.
function unit(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}
const round6 = (n) => Math.round(n * 1e6) / 1e6;

function addWave3({ S, ROWS, docs, add, owner }) {
  const B = readBasemap();
  const houses = B.houses();
  const city = 'Fort Thomas, KY 41075';
  const full = (h) => h.address + ', ' + city;
  const jordanStreet = S.street; // "214 Sample Ridge Rd"
  const jordan = houses.find((h) => h.address === jordanStreet);
  if (!jordan) throw new Error('build-demo-seed: basemap.js has no house at ' + jordanStreet + ' (the story customer must live on the sample map)');

  // The story customer's pin sits on her house on the sample map.
  docs['leads/sample-lead-01'].lat = jordan.lat;
  docs['leads/sample-lead-01'].lng = jordan.lng;

  // The storm: the story's "Fort Thomas north" hail swath, ten days ago (Jordan
  // was knocked the day after). An ellipse SW→NE over the neighbourhood.
  const cLat = 39.0752, cLng = -84.4468, a = 0.0105, b = 0.0042, rot = 38 * Math.PI / 180;
  const kLng = 1 / Math.cos(cLat * Math.PI / 180);
  const swath = []; // [lat, lng]
  for (let i = 0; i < 24; i++) {
    const t = (i / 24) * Math.PI * 2;
    const x = Math.cos(t) * a, y = Math.sin(t) * b;
    swath.push([round6(cLat + x * Math.sin(rot) + y * Math.cos(rot)), round6(cLng + (x * Math.cos(rot) - y * Math.sin(rot)) * kLng)]);
  }
  swath.push(swath[0].slice());
  if (!B.inRing([jordan.lat, jordan.lng], swath)) throw new Error('build-demo-seed: the sample hail swath must cover the story customer');
  const ringLngLat = swath.map((p) => [p[1], p[0]]);
  const lats = swath.map((p) => p[0]), lngs = swath.map((p) => p[1]);
  const bounds = { north: Math.max(...lats), south: Math.min(...lats), east: Math.max(...lngs), west: Math.min(...lngs) };
  const STORM_DAYS = -10;
  const hail = [
    [0.00, 0.000, 1.75], [0.0020, 0.0035, 1.50], [-0.0018, -0.0030, 1.50], [0.0042, 0.0062, 1.25], [-0.0040, -0.0068, 1.25],
    [0.0009, -0.0012, 1.75], [0.0062, 0.0090, 1.00], [-0.0060, -0.0095, 1.00], [0.0028, 0.0010, 1.25]
  ].map(([dLat, dLng, size], i) => ({
    lat: round6(cLat + dLat), lng: round6(cLng + dLng), sizeInches: size,
    at: { __iso: { days: STORM_DAYS, hour: 17, minute: 10 + i * 3 } },
    source: 'Sample storm report (not real NWS data)'
  }));
  hail.forEach((h) => { if (!B.inRing([h.lat, h.lng], swath)) throw new Error('build-demo-seed: sample hail report outside the swath at ' + h.lat + ',' + h.lng); });
  const maxHail = Math.max(...hail.map((h) => h.sizeInches));

  // The rep (the sample owner) and the storm territory D2D draws.
  add('reps/' + UID, { userId: UID, name: owner, initials: 'SS', companyId: UID, isSample: true, createdAt: ts(-120) });
  const ZONE_ID = 'sz_sample_fort_thomas';
  add('territories/sample-territory-01', {
    name: '🌩️ ' + S.zone + ' (sample hail swath)', type: 'polygon', assignedRep: null,
    geoJSON: { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ringLngLat] }, properties: {} },
    bounds, priority: maxHail >= 1.5 ? 'CRITICAL' : 'HIGH', stormZoneId: ZONE_ID,
    stormHail: { maxSizeInches: maxHail, hits: hail.length },
    companyId: UID, userId: UID, isSample: true, createdAt: ts(STORM_DAYS + 1, 8), updatedAt: ts(STORM_DAYS + 1, 8)
  });

  // Door knocks on the sample map's houses. Jordan's door is the appointment
  // that became the story's lead; the rest are a believable week of knocking
  // inside the swath (some doors twice).
  const DISPO = [ // [key, share]
    ['not_home', 0.30], ['left_material', 0.10], ['storm_damage', 0.12], ['interested', 0.10], ['not_interested', 0.10],
    ['come_back', 0.05], ['callback', 0.04], ['ins_has_claim', 0.04], ['ins_needs_file', 0.04], ['appointment', 0.03],
    ['tenant', 0.03], ['do_not_knock', 0.03], ['vacant', 0.02]
  ];
  const pick = (u) => { let acc = 0; for (const [k, w] of DISPO) { acc += w; if (u < acc) return k; } return 'not_home'; };
  const NOTE = {
    not_home: 'Nobody home.', left_material: 'Left a door hanger with the storm date.', storm_damage: 'Hail hits on the gutters and a soft metal vent. Wants a full look.',
    interested: 'Interested in an inspection, asked us to come back with times.', not_interested: 'Not interested right now.',
    come_back: 'Asked us to come back Saturday morning.', callback: 'Asked for a call this evening.', ins_has_claim: 'Already filed a claim; adjuster not out yet.',
    ins_needs_file: 'Damage on the north slope. Talked about how a claim works; their call.', appointment: 'Inspection booked.',
    tenant: 'Renter: left the owner a note.', do_not_knock: 'Asked not to be knocked again.', vacant: 'Looks vacant.'
  };
  const inSwath = houses.filter((h) => h !== jordan && B.inRing([h.lat, h.lng], swath));
  const chosen = inSwath.filter((h) => unit('knock:' + h.address) < 0.17);
  const knocks = [];
  const knock = (h, disposition, daysAgo, hour, attempt, extra) => {
    const id = 'sample-knock-' + String(knocks.length + 1).padStart(2, '0');
    const fu = DISPOSITIONS_FOLLOW_UP[disposition];
    const k = Object.assign({
      userId: UID, repId: UID, repName: owner, companyId: UID, isSample: true,
      address: full(h), lat: h.lat, lng: h.lng, disposition,
      homeowner: '', phone: '', email: '', smsConsent: false, notes: NOTE[disposition] || '',
      stage: disposition === 'appointment' ? 'appointment' : /^ins_/.test(disposition) ? 'insurance' : 'knock',
      attemptNumber: attempt, convertedToLead: false, estimateValue: 0, closedDealValue: 0, insCarrier: '', claimNumber: '',
      photoUrls: [], photoPaths: [], followUpTime: '',
      addrConfidence: 'verified', addrConfirmed: true, addrHouseNumber: String(h.number), addrSources: [], addrRoundTripMeters: 0, addrNeedsReverify: false,
      createdAt: ts(-daysAgo, hour), updatedAt: ts(-daysAgo, hour), addrVerifiedAt: ts(-daysAgo, hour)
    }, extra || {});
    if (fu) { k.followUpDate = ts(-daysAgo + fu, 10); k.followUpSource = 'disposition'; }
    add('knocks/' + id, k);
    knocks.push(k);
  };
  knock(jordan, 'appointment', 9, 11, 1, {
    homeowner: S.customer, notes: 'Hail bruising on the north and west slopes. Inspection booked; became the lead.',
    convertedToLead: true, leadId: 'sample-lead-01', insCarrier: S.carrier
  });
  chosen.forEach((h, i) => {
    const u = unit('dispo:' + h.address);
    const daysAgo = 1 + Math.floor(unit('day:' + h.address) * 8);
    const hour = 10 + Math.floor(unit('hour:' + h.address) * 9);
    const d = pick(u);
    // Every fourth "not home" door was knocked again later and answered.
    if (d === 'not_home' && i % 4 === 0 && daysAgo > 2) {
      knock(h, 'not_home', daysAgo, hour, 1);
      knock(h, unit('again:' + h.address) < 0.5 ? 'interested' : 'storm_damage', daysAgo - 2, Math.min(19, hour + 1), 2);
    } else knock(h, d, daysAgo, hour, 1);
  });

  // Storm reports for the D2D "Storms" layer (/api/storm-report shape) and the
  // hail lookup (getHailHistory shape): this storm, plus older sample ones.
  const reports = hail.map((h) => ({ type: 'hail', lat: h.lat, lon: h.lng, date: h.at, magnitude: h.sizeInches, city: 'Fort Thomas (sample)' }))
    .concat([
      { type: 'wind', lat: 39.0790, lon: -84.4420, date: { __iso: { days: STORM_DAYS, hour: 17, minute: 4 } }, magnitude: 60, city: 'Fort Thomas (sample)' },
      { type: 'wind', lat: 39.0705, lon: -84.4540, date: { __iso: { days: STORM_DAYS, hour: 17, minute: 2 } }, magnitude: 58, city: 'Fort Thomas (sample)' },
      { type: 'hail', lat: 38.9989, lon: -84.6266, date: { __iso: { days: -210, hour: 15 } }, magnitude: 1.0, city: 'Florence (sample)' },
      { type: 'hail', lat: 39.3328, lon: -84.4083, date: { __iso: { days: -420, hour: 18 } }, magnitude: 1.25, city: 'West Chester (sample)' },
      { type: 'wind', lat: 39.1753, lon: -84.2944, date: { __iso: { days: -75, hour: 16 } }, magnitude: 65, city: 'Milford (sample)' }
    ]);

  // Storm Center keeps its zones in this browser (localStorage), so the zone
  // ships here and docs/pro/demo-sdk/offline.js puts it in place on first load.
  const zone = {
    id: ZONE_ID, alertId: null, name: '🌩️ ' + S.zone + ' (sample)', event: 'Observed Hail', severity: 'Severe', score: 80,
    damageProb: 0.6, hailSize: maxHail, windSpeed: 60, polygon: swath, center: [cLat, cLng],
    areaDesc: hail.length + ' sample hail reports up to ' + maxHail.toFixed(2) + '" (sample data, not real NWS reports)',
    createdAt: { __iso: { days: STORM_DAYS + 1, hour: 8 } }, alertExpires: null, status: 'canvassing',
    knockCount: knocks.filter((k) => B.inRing([k.lat, k.lng], swath)).length, leadCount: 1, estimatedRoofs: 0,
    assignedReps: [], canvassPlan: null, notes: 'Sample zone: the story\'s storm.', source: 'd2d-rep', isSample: true
  };
  // ~200 homes / sq mi, the Storm Center's own estimate.
  zone.estimatedRoofs = Math.round(Math.abs(swath.reduce((s, p, i) => {
    const q = swath[(i + 1) % swath.length]; return s + p[1] * q[0] - q[1] * p[0];
  }, 0) / 2) * 69 * 53 * 200);

  // One sample weather alert for today, a few miles south-east, so Storm
  // Center's alert list, map polygon and "Create Zone" have something to show.
  // Clearly marked: it is not a real National Weather Service warning.
  const alertRing = [[-84.4330, 39.0050], [-84.3700, 39.0050], [-84.3600, 38.9550], [-84.4250, 38.9450], [-84.4330, 39.0050]];
  const nwsAlert = {
    type: 'Feature', id: 'sample-alert-01',
    geometry: { type: 'Polygon', coordinates: [alertRing] },
    properties: {
      id: 'sample-alert-01', event: 'Severe Thunderstorm Warning',
      headline: 'SAMPLE ALERT (not a real warning): Severe Thunderstorm Warning for Campbell County, KY',
      description: 'Sample data for the sample account, not issued by the National Weather Service. A storm capable of 1.25 inch hail and 60 mph wind gusts over Cold Spring and Alexandria.',
      severity: 'Severe', certainty: 'Likely', urgency: 'Immediate', areaDesc: 'Campbell, KY (sample)',
      sent: { __isoNow: { minutes: -40 } }, effective: { __isoNow: { minutes: -40 } }, expires: { __isoNow: { minutes: 80 } },
      senderName: 'Sample data (not the National Weather Service)', geocode: { UGC: ['KYC037'] }
    }
  };

  // ── Agent inbox: what the sample company's own bots filed ──────────────
  // Bot names are the sample company's own (never NBD's bots). Drafts wait for
  // the owner; in the sample account "send" shows what would go out and that
  // nothing was sent (firebase-functions.js agentDraftAction).
  const BOT = { follow: S.bot, office: 'Office helper', check: 'Fact checker', social: 'Social helper' };
  const inbox = (n, d) => add('agent_inbox/sample-inbox-' + String(n).padStart(2, '0'), Object.assign({
    companyId: UID, status: 'pending', verified: false, isSample: true, keyId: 'sample-key', dueDate: null, leadId: null, title: '', createdAt: ts(-1, 7 + n)
  }, d));
  inbox(1, { kind: 'draft_text', bot: BOT.follow, botId: 'follow_up', leadId: 'sample-lead-01', text: readStoryDraft(),
    reason: 'Jordan has had the three roof options since Wednesday and has not replied.', consentOnFile: true });
  inbox(2, { kind: 'draft_email', bot: BOT.follow, botId: 'follow_up', leadId: 'sample-lead-13', title: 'Your three roof options from ' + S.company,
    text: 'Hi Caleb,\n\nThanks again for having us out. Your estimate has the Standard, Preferred and Elite packages side by side, each with the GAF System Plus Limited Warranty. ' +
      'If you have questions about any of them, reply here or call me at (859) 555-0100.\n\nSam\n' + S.company,
    reason: 'Retail estimate sent 8 days ago, no reply yet.', from: 'info', fromAddress: 'office@sample-roofing.example' });
  inbox(3, { kind: 'reminder', bot: BOT.office, botId: 'office', leadId: 'sample-lead-10', title: 'Adjuster meeting prep', dueDate: date(1),
    text: 'Bring the photo report and the ladder to Lena Ortiz\'s adjuster meeting.', verified: true, verifiedBy: BOT.check });
  inbox(4, { kind: 'note', bot: BOT.office, botId: 'office', leadId: 'sample-lead-16', title: '',
    text: 'Kentucky insurance job: nothing is collected at signing. The deductible is due after the carrier\'s decision, as the contract says.', verified: true, verifiedBy: BOT.check });
  inbox(5, { kind: 'report', bot: BOT.office, botId: 'office', title: 'Storm follow-up: Fort Thomas north (sample)',
    text: 'Since the storm: ' + knocks.length + ' doors knocked in the swath, ' + knocks.filter((k) => /storm_damage|interested|appointment|ins_/.test(k.disposition)).length +
      ' worth a second visit, 1 inspection booked (Jordan Avery). Sample numbers from the sample account.' });
  inbox(6, { kind: 'social_draft', bot: BOT.social, botId: 'social', title: S.company + ' · Facebook', platform: 'facebook', brand: null, mediaUrl: null, scheduledFor: null,
    text: 'Hail came through Fort Thomas last week. If you are not sure what it did to your roof, we can take a look and show you photos of what we find. ' + S.company + ', (859) 555-0100.',
    reason: 'Recent storm in your service area.' });

  return {
    '//': 'Answers the sample account gives instead of calling other sites (docs/pro/demo-sdk/offline.js). Sample data, not real reports.',
    home: { lat: jordan.lat, lng: jordan.lng, accuracy: 12, label: S.street + ', ' + S.cityLine },
    city, swath, swathBounds: bounds, hail, reports, stormZones: [zone], nwsAlerts: [nwsAlert]
  };
}
// Days to the follow-up a disposition sets (d2d-tracker-core-2026b.js DISPOSITIONS autoFollowUp).
const DISPOSITIONS_FOLLOW_UP = { ins_has_claim: 2, ins_needs_file: 1, storm_damage: 1, interested: 3, come_back: 2, callback: 1, revisit: 1, not_home: 1, left_material: 3, ins_denied: 3, vacant: 7 };

function main() {
  const json = JSON.stringify(build(), null, 1) + '\n';
  if (process.argv.includes('--check')) {
    const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n') : '';
    if (cur !== json) { console.error('build-demo-seed: ' + path.relative(ROOT, OUT) + ' is stale. Run: node scripts/build-demo-seed.js'); process.exit(1); }
    console.log('build-demo-seed: up to date');
    return;
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, json);
  console.log('build-demo-seed: wrote ' + path.relative(ROOT, OUT) + ' (' + Object.keys(JSON.parse(json).docs).length + ' docs)');
}

if (require.main === module) main();
module.exports = { build, readSample };
