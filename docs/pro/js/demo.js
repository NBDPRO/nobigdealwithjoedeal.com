// ============================================================
// NBD Pro — demo.js
// Demo data seeder for first-time users
// Extracted from dashboard.html
// ============================================================

async function maybeSeedDemoData(user) {
  if (!user || user.email !== DEMO_EMAIL) return;
  // Check if already seeded
  try {
    const existing = await getDocs(query(collection(db,'leads'), where('userId','==',user.uid)));
    if (existing.docs.length > 0) return; // Already has data
  } catch(e) { return; }

  showToast('Loading demo data...');
  await seedDemoLeads(user.uid);
  await seedDemoEstimates(user.uid);
  await loadLeads();
  await window._loadEstimates?.();
  showToast('Demo loaded — welcome to NBD Pro ✓');
}

async function seedDemoLeads(uid) {
  const now = new Date();
  const daysAgo = d => { const x=new Date(now); x.setDate(x.getDate()-d); return x; };
  const daysAhead = d => { const x=new Date(now); x.setDate(x.getDate()+d); return x.toISOString().split('T')[0]; };

  const leads = [
    // NEW LEADS (2)
    { firstName:'Brian', lastName:'Kowalski', address:'1847 Clough Pike, Batavia OH 45103', phone:'(513) 555-0101', email:'bkowalski@example.com', stage:'New', source:'Door Knock', damageType:'Roof - Hail', claimStatus:'No Claim', jobValue:14200, followUp: daysAhead(1), insCarrier:'', notes:'Large hail hit whole street. Homeowner interested. 2-story colonial, 28 sq estimated.', createdAt: daysAgo(1) },
    { firstName:'Donna', lastName:'Pryce', address:'334 Linwood Ave, Milford OH 45150', phone:'(513) 555-0102', email:'', stage:'New', source:'Storm Canvass', damageType:'Roof - Hail & Wind', claimStatus:'No Claim', jobValue:11800, followUp: daysAhead(2), insCarrier:'', notes:'Visible hail damage on ridge cap. Siding dinged on south face. No claim filed yet.', createdAt: daysAgo(2) },

    // INSPECTED (2)
    { firstName:'Mark', lastName:'Deluca', address:'5520 Wolfpen Pleasant Hill, Milford OH 45150', phone:'(513) 555-0103', email:'mdeluca@example.com', stage:'Inspected', source:'Referral', damageType:'Full Exterior', claimStatus:'Claim Filed', jobValue:28400, followUp: daysAhead(1), insCarrier:'State Farm', notes:'Full exterior hit. Roof 24sq, siding 1800sf, gutters all 4 sides. State Farm adjuster scheduled Thursday.', createdAt: daysAgo(4) },
    { firstName:'Carla', lastName:'Washington', address:'912 US-50, Amelia OH 45102', phone:'(513) 555-0104', email:'cwashington@example.com', stage:'Inspected', source:'Door Knock', damageType:'Roof - Wind', claimStatus:'No Claim', jobValue:9600, followUp: daysAhead(3), insCarrier:'', notes:'Two sections of shingles blown off. Deck exposed. Needs emergency tarping — already done. Waiting on her decision to file.', createdAt: daysAgo(3) },

    // ESTIMATE SENT (2)
    { firstName:'Todd', lastName:'Heffner', address:'6103 Bach Buxton Rd, Goshen OH 45122', phone:'(513) 555-0105', email:'todd.heffner@example.com', stage:'Estimate Sent', source:'Door Knock', damageType:'Roof - Hail', claimStatus:'Claim Filed', jobValue:16750, followUp: daysAhead(0), insCarrier:'Nationwide', notes:'Sent $16,750 estimate yesterday. Nationwide claim in. Adjuster coming next week. Need to follow up TODAY.', createdAt: daysAgo(6) },
    { firstName:'Patricia', lastName:'Nguyen', address:'2240 Loveland-Miamiville Rd, Loveland OH 45140', phone:'(513) 555-0106', email:'pnguyen@example.com', stage:'Estimate Sent', source:'Referral', damageType:'Siding - Hail', claimStatus:'Adjuster Scheduled', jobValue:8900, followUp: daysAhead(4), insCarrier:'Allstate', notes:'Allstate adjuster Thursday 2pm. Sent scope and estimate. Her neighbor is our customer — warm referral.', createdAt: daysAgo(5) },

    // APPROVED (2)
    { firstName:'Kevin', lastName:'Strauss', address:'745 N. Three Notch Rd, Amelia OH 45102', phone:'(513) 555-0107', email:'kstrauss@example.com', stage:'Approved', source:'Door Knock', damageType:'Roof - Hail & Wind', claimStatus:'Approved', jobValue:21300, followUp: daysAhead(5), insCarrier:'State Farm', notes:'Claim approved $21,300. Waiting on ACV check before scheduling. Need to supplement for O&P and ice & water.', createdAt: daysAgo(10) },
    { firstName:'Angela', lastName:'Morrison', address:'4488 Bantam Rd, Batavia OH 45103', phone:'(513) 555-0108', email:'amorrison@example.com', stage:'Approved', source:'Storm Canvass', damageType:'Full Exterior', claimStatus:'Supplementing', jobValue:34800, followUp: daysAhead(2), insCarrier:'Cincinnati Insurance', notes:'Big job. Claim approved but low — $28K. Supplementing for felt, drip edge, O&P, siding labor. Should get to $34-35K.', createdAt: daysAgo(12) },

    // IN PROGRESS (2)
    { firstName:'Robert', lastName:'Finley', address:'1122 Elm St, Mason OH 45040', phone:'(513) 555-0109', email:'rfinley@example.com', stage:'In Progress', source:'Referral', damageType:'Roof - Hail', claimStatus:'Approved', jobValue:18500, followUp: daysAhead(7), insCarrier:'Travelers', notes:'Crew on site Tuesday. 22sq Owens Corning Duration Storm, charcoal. Dumpster dropped. On track.', createdAt: daysAgo(18) },
    { firstName:'Susan', lastName:'Becker', address:'8834 Clough Pike, Anderson Township OH 45244', phone:'(513) 555-0110', email:'sbecker@example.com', stage:'In Progress', source:'Door Knock', damageType:'Full Exterior', claimStatus:'Paid Out', jobValue:41200, followUp: daysAhead(10), insCarrier:'Erie Insurance', notes:'Largest job this season. Roof done, siding crew starts Monday. ACV check cleared. Final invoice after siding complete.', createdAt: daysAgo(22) },

    // COMPLETE (2)
    { firstName:'James', lastName:'Holloway', address:'3301 Bach Buxton Rd, Batavia OH 45103', phone:'(513) 555-0111', email:'jholloway@example.com', stage:'Complete', source:'Door Knock', damageType:'Roof - Hail', claimStatus:'Paid Out', jobValue:15600, followUp:'', insCarrier:'Nationwide', notes:'Job complete. Final payment received. Left 5-star Google review. Good referral source — knows half the street.', createdAt: daysAgo(35) },
    { firstName:'Linda', lastName:'Garrett', address:'617 SR-28, Milford OH 45150', phone:'(513) 555-0112', email:'lgarrett@example.com', stage:'Complete', source:'Referral', damageType:'Siding - Hail', claimStatus:'Paid Out', jobValue:12400, followUp:'', insCarrier:'State Farm', notes:'Board & batten vinyl, storm gray. Clean job. Referred her daughter already — follow up in spring.', createdAt: daysAgo(28) },

    // LOST (1)
    { firstName:'Gary', lastName:'Simmons', address:'4400 Merwin-Ten Mile Rd, Loveland OH 45140', phone:'(513) 555-0113', email:'', stage:'Lost', source:'Door Knock', damageType:'Roof - Hail', claimStatus:'Denied', jobValue:13200, followUp:'', insCarrier:'Progressive', notes:'Progressive denied claim — said damage pre-existing. Homeowner not willing to fight it. Filed it away — may revisit next storm season.', createdAt: daysAgo(20) },
  ];

  const batch = [];
  for (const lead of leads) {
    const { createdAt, ...rest } = lead;
    try {
      const ref = await addDoc(collection(db,'leads'), {
        ...rest,
        userId: uid,
        companyId: window._userClaims?.companyId || uid,
        // Sample leads use their own small allowance (functions/lead-cap.js),
        // so Load Sample Data no longer eats a Free plan's monthly cap.
        meter: 'sample',
        isSample: true,
        // Normalized inbound-SMS match key — see functions/phone-utils.js.
        phoneDigits: String(rest.phone || '').replace(/\D/g, '').replace(/^1/, '').slice(-10),
        createdAt: createdAt,
        updatedAt: createdAt,
      });
      batch.push({ id: ref.id, ...rest });
    } catch(e) { console.error('seed lead error', e); }
  }

  // Seed tasks on a few leads
  if (batch.length > 0) {
    const taskSeed = [
      { leadIdx:4, text:'Call to confirm adjuster date', dueDate: new Date().toISOString().split('T')[0] },
      { leadIdx:4, text:'Send insurance auth form', dueDate: new Date().toISOString().split('T')[0] },
      { leadIdx:6, text:'Submit supplement to State Farm', dueDate: (() => { const d=new Date(); d.setDate(d.getDate()+1); return d.toISOString().split('T')[0]; })() },
      { leadIdx:7, text:'Follow up on supplement response', dueDate: (() => { const d=new Date(); d.setDate(d.getDate()+2); return d.toISOString().split('T')[0]; })() },
      { leadIdx:8, text:'Order materials from ABC Supply', dueDate: new Date().toISOString().split('T')[0] },
      { leadIdx:1, text:'Call to schedule inspection', dueDate: (() => { const d=new Date(); d.setDate(d.getDate()+1); return d.toISOString().split('T')[0]; })() },
    ];
    for (const t of taskSeed) {
      const lead = batch[t.leadIdx];
      if (!lead) continue;
      try {
        await addDoc(collection(db,'leads',lead.id,'tasks'), {
          text: t.text, done: false, dueDate: t.dueDate, createdAt: new Date()
        });
      } catch(e) { console.error('seed task error', e); }
    }
  }
}

async function seedDemoEstimates(uid) {
  const estimates = [
    {
      address:'1847 Clough Pike, Batavia OH 45103', owner:'Brian Kowalski',
      parcel:'', sqft:2800, pitch:'6/12', waste:15,
      package:'Better', total:14200,
      lineItems:[
        {desc:'Remove & Replace Architectural Shingles (28 SQ)',qty:28,unit:'SQ',price:185,ext:5180},
        {desc:'Tear-Off & Disposal',qty:28,unit:'SQ',price:55,ext:1540},
        {desc:'Synthetic Underlayment',qty:28,unit:'SQ',price:22,ext:616},
        {desc:'Drip Edge (LF)',qty:240,unit:'LF',price:2.10,ext:504},
        {desc:'Ridge Cap Shingles',qty:1,unit:'EA',price:280,ext:280},
        {desc:'Pipe Boots (4)',qty:4,unit:'EA',price:45,ext:180},
        {desc:'Ice & Water Shield (2 SQ)',qty:2,unit:'SQ',price:95,ext:190},
        {desc:'Labor & Installation',qty:28,unit:'SQ',price:195,ext:5460},
      ],
      createdAt: new Date(),
    },
    {
      address:'5520 Wolfpen Pleasant Hill, Milford OH 45150', owner:'Mark Deluca',
      parcel:'', sqft:3600, pitch:'8/12', waste:17,
      package:'Best', total:28400,
      lineItems:[
        {desc:'Remove & Replace Impact-Resistant Shingles (34 SQ)',qty:34,unit:'SQ',price:225,ext:7650},
        {desc:'Tear-Off & Disposal',qty:34,unit:'SQ',price:55,ext:1870},
        {desc:'Siding Replacement — Hardie Plank (1800 SF)',qty:1800,unit:'SF',price:6.20,ext:11160},
        {desc:'Gutter Replacement — 6" K-Style (180 LF)',qty:180,unit:'LF',price:8.50,ext:1530},
        {desc:'Downspouts (6)',qty:6,unit:'EA',price:95,ext:570},
        {desc:'Drip Edge & Flashing',qty:1,unit:'EA',price:620,ext:620},
        {desc:'Pipe Boots & Accessories',qty:1,unit:'EA',price:380,ext:380},
        {desc:'Ridge Cap & Ventilation',qty:1,unit:'EA',price:490,ext:490},
        {desc:'O&P (10%)',qty:1,unit:'EA',price:2413,ext:2413},
      ],
      createdAt: new Date(),
    },
  ];

  for (const est of estimates) {
    try {
      await addDoc(collection(db,'estimates'), { ...est, userId: uid });
    } catch(e) { console.error('seed estimate error', e); }
  }
}
// ══ END DEMO SEEDER ═══════════════════════════════════════════════════

// ══ Window Scope Exposures ══════════════════════════════════
window.maybeSeedDemoData = maybeSeedDemoData;
window.seedDemoLeads = seedDemoLeads;
