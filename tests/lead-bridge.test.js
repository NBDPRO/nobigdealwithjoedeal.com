/**
 * tests/lead-bridge.test.js — public-lead → CRM bridge logic (Phase C, H-1).
 *
 * Pure unit test of functions/lead-bridge-logic.js: owner/tenant resolution,
 * field mapping, deterministic idempotency id. Zero deps (no emulator) — the
 * Firestore I/O lives in lead-bridge.js; everything tested here is pure.
 *
 * Run: node tests/lead-bridge.test.js
 */
'use strict';

const path = require('path');
const L = require(path.join(__dirname, '..', 'functions', 'lead-bridge-logic.js'));

let passed = 0, failed = 0; const fails = [];
function ok(name, cond) { if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; fails.push(name); console.log('  ✗ ' + name); } }

const NBD = '1phDvAVXHSg82wDLegAbQFq14Ci1';        // tenant-zero owner uid
const SCOTT = 'ScottOaksUid000000000000abcd';      // looks-like-uid (28 chars)

console.log('LEAD-BRIDGE — kinds bridged');
ok('contact_leads bridged', !!L.BRIDGE_KINDS.contact_leads);
ok('estimate_leads bridged', !!L.BRIDGE_KINDS.estimate_leads);
ok('inspect_leads bridged', !!L.BRIDGE_KINDS.inspect_leads);
ok('free_roof_entries bridged', !!L.BRIDGE_KINDS.free_roof_entries);
ok('guide_leads NOT bridged (list-builder)', !L.BRIDGE_KINDS.guide_leads);
// storm is now CONDITIONALLY bridged (high-intent concerns only) — it has a
// BRIDGE_KINDS entry (for the source label) but the trigger gates on concern.
ok('storm_alert_subscribers has a bridge mapping', !!L.BRIDGE_KINDS.storm_alert_subscribers);

console.log('\nLEAD-BRIDGE — storm concern gate (shouldBridgeStorm)');
ok('storm insurance → bridge', L.shouldBridgeStorm({ concern: 'insurance' }) === true);
ok('storm wind → bridge', L.shouldBridgeStorm({ concern: 'wind' }) === true);
ok('storm general → bridge', L.shouldBridgeStorm({ concern: 'general' }) === true);
ok('storm hail (form default) → NOT bridged (list-only)', L.shouldBridgeStorm({ concern: 'hail' }) === false);
ok('storm missing concern → NOT bridged', L.shouldBridgeStorm({}) === false);
ok('storm concern case-insensitive', L.shouldBridgeStorm({ concern: 'Insurance' }) === true);
ok('alert + bridge share one concern set (no drift)',
  L.HIGH_INTENT_STORM_CONCERNS.join(',') === ['insurance', 'wind', 'general'].join(','));
{
  // Storm lead maps with the Storm Alert source + concern in notes; zip→address.
  const sd = L.mapPublicLeadToLead({
    collection: 'storm_alert_subscribers', sourceId: 's1',
    ownerUid: NBD, companyId: NBD,
    data: { name: 'Dana Homeowner', phone: '8590001111', zip: '45122', concern: 'insurance' },
  });
  ok('storm lead source = Website — Storm Alert', sd.source === 'Website — Storm Alert');
  ok('storm lead splits name', sd.firstName === 'Dana' && sd.lastName === 'Homeowner');
  ok('storm lead zip → address', sd.address === '45122');
  ok('storm lead carries phone', sd.phone === '8590001111');
  ok('storm lead note shows the concern', /Already has damage/.test(sd.notes));
  ok('storm lead tagged publicLeadKind=storm', sd.publicLeadKind === 'storm');
}

console.log('\nLEAD-BRIDGE — owner/tenant resolution');
{
  // NBD: untagged → tenant-zero owner; solo => companyId == uid (byte-identical).
  const nbd = L.resolveBridgeTarget('', null, { nbdOwnerUid: NBD });
  ok('untagged → NBD owner', nbd && nbd.ownerUid === NBD);
  ok('untagged → companyId == NBD uid (solo)', nbd && nbd.companyId === NBD);

  // Oaks (slug companyId) with an explicit ownerId on the company doc.
  const oaks = L.resolveBridgeTarget('oaks', { ownerId: SCOTT }, { nbdOwnerUid: NBD });
  ok('oaks + ownerId → Scott owner', oaks && oaks.ownerUid === SCOTT);
  ok('oaks keeps companyId "oaks"', oaks && oaks.companyId === 'oaks');

  // Oaks slug but NO ownerId set yet → unresolvable → skip (never guess).
  const oaksNoOwner = L.resolveBridgeTarget('oaks', null, { nbdOwnerUid: NBD });
  ok('oaks w/o ownerId → null (skip, no guess)', oaksNoOwner === null);

  // Solo tenant whose companyId IS their uid (no company doc) → owns itself.
  const soloUid = L.resolveBridgeTarget(SCOTT, null, { nbdOwnerUid: NBD });
  ok('uid-shaped companyId → owns itself', soloUid && soloUid.ownerUid === SCOTT && soloUid.companyId === SCOTT);

  // No nbdOwnerUid configured + untagged → null (defensive).
  ok('untagged w/o nbd owner → null', L.resolveBridgeTarget('', null, {}) === null);

  ok('looksLikeUid: 28-char uid true', L.looksLikeUid(NBD) === true);
  ok('looksLikeUid: "oaks" false', L.looksLikeUid('oaks') === false);
}

console.log('\nLEAD-BRIDGE — idempotency id (deterministic)');
{
  const a = L.bridgeDocId('inspect_leads', 'abc123');
  ok('deterministic id', a === 'inspect_leads__abc123');
  ok('same inputs → same id', a === L.bridgeDocId('inspect_leads', 'abc123'));
  ok('different source → different id', a !== L.bridgeDocId('inspect_leads', 'xyz789'));
}

console.log('\nLEAD-BRIDGE — public lead → CRM leads doc mapping');
{
  // /inspect lead (single `name`, story, photoCount) — NBD untagged.
  const inspect = L.mapPublicLeadToLead({
    collection: 'inspect_leads', sourceId: 'src1',
    ownerUid: NBD, companyId: NBD,
    data: { name: 'Jane Homeowner', phone: '8594207382', address: '12 Oak St, Batavia OH',
            email: 'jane@example.com', story: 'Hail last week', photoCount: 4, source: 'qr-inspect' },
  });
  ok('inspect: userId = owner', inspect.userId === NBD);
  ok('inspect: companyId stamped', inspect.companyId === NBD);
  ok('inspect: firstName split', inspect.firstName === 'Jane');
  ok('inspect: lastName split', inspect.lastName === 'Homeowner');
  ok('inspect: phone mapped', inspect.phone === '8594207382');
  ok('inspect: address mapped', inspect.address === '12 Oak St, Batavia OH');
  // 2026-10-03: the canonical stage KEY + its role, not the legacy 'New' label.
  ok('inspect: stage is the canonical new key', inspect.stage === 'new');
  ok('inspect: stageRole new stamped', inspect.stageRole === 'new');
  ok('inspect: source label', inspect.source === 'Website — Inspection / Storm tool');
  ok('inspect: webLead flag', inspect.webLead === true);
  ok('inspect: provenance kind', inspect.publicLeadKind === 'inspect');
  ok('inspect: provenance collection', inspect.publicLeadCollection === 'inspect_leads');
  ok('inspect: provenance id', inspect.publicLeadId === 'src1');
  ok('inspect: notes carry story', /Hail last week/.test(inspect.notes));
  ok('inspect: notes carry photo count', /4 photo/.test(inspect.notes));
  ok('inspect: no undefined values', Object.values(inspect).every(v => v !== undefined));
  ok('inspect: sourcePage keeps the page-level source the form posted', inspect.sourcePage === 'qr-inspect');
  ok('inspect: the kind label is unchanged by attribution', inspect.source === 'Website — Inspection / Storm tool');
  const areaForm = L.mapPublicLeadToLead({ collection: 'inspect_leads', sourceId: 's9', ownerUid: NBD, companyId: NBD,
    data: { name: 'A B', phone: '5135550108', address: 'x', source: 'page-form:/areas/mason-oh' } });
  ok('area quick-form: sourcePage names the landing page', areaForm.sourcePage === 'page-form:/areas/mason-oh');
  const noSource = L.mapPublicLeadToLead({ collection: 'contact_leads', sourceId: 's10', ownerUid: NBD, companyId: NBD, data: { firstName: 'C' } });
  ok('no source posted → sourcePage is an empty string, never undefined', noSource.sourcePage === '');

  // contact lead already has firstName (no `name`) — Oaks tenant.
  const contact = L.mapPublicLeadToLead({
    collection: 'contact_leads', sourceId: 'src2',
    ownerUid: SCOTT, companyId: 'oaks',
    data: { firstName: 'Bob', phone: '5135550100', source: 'website', companyId: 'oaks' },
  });
  ok('contact: keeps firstName', contact.firstName === 'Bob');
  ok('contact: empty lastName ok', contact.lastName === '');
  ok('contact: Oaks owner + companyId', contact.userId === SCOTT && contact.companyId === 'oaks');
  ok('contact: source label', contact.source === 'Website — Contact form');

  // free_roof nomination — nomineeName + nominator context.
  const roof = L.mapPublicLeadToLead({
    collection: 'free_roof_entries', sourceId: 'src3',
    ownerUid: NBD, companyId: NBD,
    data: { nomineeName: 'Grandma Smith', phone: '5135550111', address: '9 Elm', story: 'She needs it',
            nominatorName: 'Tim', nominatorRelation: 'grandson' },
  });
  ok('free_roof: nominee → firstName/lastName', roof.firstName === 'Grandma' && roof.lastName === 'Smith');
  ok('free_roof: notes carry nominator', /Nominated by Tim \(grandson\)/.test(roof.notes));
  ok('free_roof: notes flag giveaway', /One Free Roof/.test(roof.notes));

  // missing name → safe placeholder, never blank/undefined.
  const blank = L.mapPublicLeadToLead({ collection: 'contact_leads', sourceId: 's', ownerUid: NBD, companyId: NBD, data: {} });
  ok('blank: firstName placeholder', blank.firstName === '(Web lead)');

  // utm passthrough only when present.
  const utm = L.mapPublicLeadToLead({ collection: 'estimate_leads', sourceId: 's', ownerUid: NBD, companyId: NBD,
    data: { address: '1 A St', utm_source: 'google', utm_medium: 'cpc' } });
  ok('utm: source mapped when present', utm.utmSource === 'google');
  ok('utm: campaign absent when not sent', !('utmCampaign' in utm));

  // Referral-code self-redemption: a friend entered a customer's code on the
  // public form → carried onto the CRM lead (uppercased to match the referrals
  // code format) so onReferralLeadWrite can attribute it. Absent when unsent.
  const refd = L.mapPublicLeadToLead({ collection: 'inspect_leads', sourceId: 's', ownerUid: NBD, companyId: NBD,
    data: { name: 'Pat Referred', phone: '5135550122', address: '3 B St', referralCode: 'john-ab12' } });
  ok('referral: code carried as redeemReferralCode (uppercased)', refd.redeemReferralCode === 'JOHN-AB12');
  const noRef = L.mapPublicLeadToLead({ collection: 'inspect_leads', sourceId: 's', ownerUid: NBD, companyId: NBD,
    data: { name: 'No Ref', phone: '5135550133', address: '4 C St' } });
  ok('referral: absent when not supplied', !('redeemReferralCode' in noRef));

  // estimator follow-up events must NOT bridge (4-duplicate-cards bug);
  // the initial save (no type) and unknown future types MUST bridge.
  ok('event: estimate_result skipped', L.isFollowUpEvent('estimate_leads', { type: 'estimate_result' }) === true);
  ok('event: cta_click skipped', L.isFollowUpEvent('estimate_leads', { type: 'cta_click' }) === true);
  ok('event: email_estimate_request skipped', L.isFollowUpEvent('estimate_leads', { type: 'email_estimate_request' }) === true);
  ok('event: initial save (no type) bridges', L.isFollowUpEvent('estimate_leads', { address: '1 A St' }) === false);
  ok('event: unknown type fails open (bridges)', L.isFollowUpEvent('estimate_leads', { type: 'something_new' }) === false);
  ok('event: type on other collections ignored', L.isFollowUpEvent('contact_leads', { type: 'cta_click' }) === false);
  ok('event: null data safe', L.isFollowUpEvent('estimate_leads', null) === false);

  // estimator context line on the CRM card notes.
  const est = L.mapPublicLeadToLead({ collection: 'estimate_leads', sourceId: 's', ownerUid: NBD, companyId: NBD,
    data: { address: '1 A St', service: 'roof-replacement', roofType: 'asphalt', timeline: 'asap' } });
  ok('estimate notes: service+roofType+timeline', /Instant Estimate — roof-replacement \(asphalt\) · timeline: asap/.test(est.notes));
  const estBare = L.mapPublicLeadToLead({ collection: 'estimate_leads', sourceId: 's', ownerUid: NBD, companyId: NBD,
    data: { address: '1 A St' } });
  ok('estimate notes: no context line on legacy docs', !/Instant Estimate —/.test(estBare.notes));
}

console.log('\nLEAD-BRIDGE — Thumbtack per-lead acquisition cost (leadCost)');
{
  // Thumbtack's leadPrice previously only reached the CRM as a text line
  // inside notes ("Lead cost: $51.96") — nothing promoted it to the
  // structured leadCost field lead-source-roi.js and expense-config.js's
  // DIRECT lead_acquisition category actually key on.
  const ttLead = L.mapPublicLeadToLead({
    collection: 'thumbtack_leads', sourceId: 'tt1', ownerUid: NBD, companyId: NBD,
    data: { firstName: 'Pat', lastName: 'Thumbtack', phone: '5135550199', leadPrice: '51.96',
            notes: 'Thumbtack — Roof Repair\nLead cost: 51.96' },
  });
  ok('thumbtack: leadPrice → structured leadCost (number)', ttLead.leadCost === 51.96);

  const ttDollarSign = L.mapPublicLeadToLead({
    collection: 'thumbtack_leads', sourceId: 'tt2', ownerUid: NBD, companyId: NBD,
    data: { name: 'Dollar Sign', leadPrice: '$1,234.56' },
  });
  ok('thumbtack: leadPrice strips $ and thousands comma', ttDollarSign.leadCost === 1234.56);

  const ttNoPrice = L.mapPublicLeadToLead({
    collection: 'thumbtack_leads', sourceId: 'tt3', ownerUid: NBD, companyId: NBD,
    data: { name: 'No Price' },
  });
  ok('thumbtack: no leadPrice → leadCost absent (never a speculative 0)', !('leadCost' in ttNoPrice));

  const ttZeroPrice = L.mapPublicLeadToLead({
    collection: 'thumbtack_leads', sourceId: 'tt4', ownerUid: NBD, companyId: NBD,
    data: { name: 'Free Lead', leadPrice: '0' },
  });
  ok('thumbtack: leadPrice of 0 stays absent (genuinely free ≠ untracked — matches backfill convention)', !('leadCost' in ttZeroPrice));

  const nonTt = L.mapPublicLeadToLead({
    collection: 'contact_leads', sourceId: 'c1', ownerUid: NBD, companyId: NBD,
    data: { firstName: 'No', lastName: 'Cost', leadPrice: '99.00' },
  });
  ok('non-external collection ignores a stray leadPrice-shaped field', !('leadCost' in nonTt));
}

console.log('\n──────────────────────────────────────────────────');
console.log(`${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('✓ All lead-bridge logic tests passed');
