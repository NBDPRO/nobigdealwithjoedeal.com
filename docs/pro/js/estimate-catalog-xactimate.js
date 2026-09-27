/*! © 2026 No Big Deal Home Solutions — All Rights Reserved. Proprietary; no license granted — see LICENSE at the repo root. https://nobigdealwithjoedeal.com */
// ============================================================
// NBD Pro — Xactimate-Style Line Item Catalog
//
// 250+ roofing / exterior line items with:
//   - Xactimate-style codes (RFG xxx, GTR xxx, FSC xxx, etc.)
//   - Material + labor unit costs (Cincinnati / Ohio April 2026)
//   - OH + KY + IRC building code references
//   - Insurance-scope justification text per item
//   - Tier assignment (good / better / best / any)
//
// Source: NRCA Guidelines + Ohio Residential Code (OBC) +
// Kentucky Residential Code (KRC) + 2021 IRC + regional supplier
// pricing and in-house productivity data.
//
// NOTE: this file is served unauthenticated at
// /pro/js/estimate-catalog-xactimate.js. Do NOT name specific
// suppliers, branches, negotiated rates or the source of the
// productivity figures here — that discloses commercial
// relationships to anyone who views source.
//
// This is the CATALOG ONLY — pricing math is handled by
// estimate-builder-v2.js. This file registers entries under
// window.NBD_XACT_CATALOG and merges them into the v2
// engine's catalog on load.
// ============================================================

(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  const ITEMS = [];

  // Compact helper — Push a new catalog item with sensible defaults.
  // Required fields: code, name, cat, unit, mat, lab
  // Optional:        sub, desc, oh, ky, irc, nrca, reason, tier, tags, req
  function A(o) {
    const defaults = {
      tier: 'any',
      tags: [],
      requiresPhoto: false,
      insuranceDefault: false,
      retailDefault: false
    };
    const merged = Object.assign({}, defaults, o);
    // Map compact `cat` → `category` (drop `cat` from final item)
    if (merged.cat) {
      merged.category = merged.cat;
      delete merged.cat;
    } else {
      merged.category = merged.category || 'roofing';
    }
    ITEMS.push(merged);
  }

  // ═════════════════════════════════════════════════════════
  // 1. ROOFING — SHINGLES (40)
  // ═════════════════════════════════════════════════════════

  // 3-Tab (legacy / rentals)
  A({ code:'RFG 3T20', name:'3-Tab Shingles 20yr', sub:'shingles-3tab', cat:'roofing', unit:'SQ', mat:75, lab:55,
      desc:'Basic 3-tab asphalt shingle. Entry-level option.', tier:'good',
      oh:'OBC R905.2', ky:'KRC R905.2', irc:'IRC R905.2',
      reason:'Primary roof covering — asphalt shingles allowed per OBC R905.2.',
      tags:['shingle','3-tab','economy'] });
  A({ code:'RFG 3T25', name:'3-Tab Shingles 25yr', sub:'shingles-3tab', cat:'roofing', unit:'SQ', mat:85, lab:55,
      tier:'good', oh:'OBC R905.2', ky:'KRC R905.2', irc:'IRC R905.2',
      reason:'Primary roof covering — asphalt shingles allowed per OBC R905.2.',
      tags:['shingle','3-tab','economy'] });

  // GAF Architectural
  A({ code:'RFG 240-GAF-HD', name:'GAF Timberline HD Architectural', sub:'shingles-arch', cat:'roofing', unit:'SQ', mat:95, lab:62,
      desc:'Budget architectural laminate shingle, 20yr limited.', tier:'good',
      oh:'OBC R905.2', ky:'KRC R905.2', irc:'IRC R905.2',
      reason:'Laminated asphalt shingles required per OBC R905.2.1 minimum 4 fasteners per shingle.',
      tags:['shingle','gaf','architectural','laminated'] });
  A({ code:'RFG 240-GAF-HDZ', name:'GAF Timberline HDZ', sub:'shingles-arch', cat:'roofing', unit:'SQ', mat:115, lab:65,
      desc:'Architectural laminate with LayerLock + StainGuard Plus. 130mph wind rating.', tier:'better',
      oh:'OBC R905.2', ky:'KRC R905.2', irc:'IRC R905.2.4',
      reason:'Wind-resistant laminated asphalt shingles installed per manufacturer spec with 130mph wind warranty.',
      tags:['shingle','gaf','architectural','laminated','wind-resistant'], insuranceDefault:true });
  A({ code:'RFG 240-GAF-UHD', name:'GAF Timberline UHD', sub:'shingles-arch', cat:'roofing', unit:'SQ', mat:135, lab:68,
      desc:'Premium architectural with Ultra High Definition color platform.', tier:'better',
      oh:'OBC R905.2', ky:'KRC R905.2', irc:'IRC R905.2',
      reason:'Premium laminated asphalt shingles with enhanced UV resistance.',
      tags:['shingle','gaf','architectural','premium'] });
  A({ code:'RFG ARM-GAF', name:'GAF Timberline Armorshield II (Impact Class 4)', sub:'shingles-impact', cat:'roofing', unit:'SQ', mat:165, lab:72,
      desc:'Class 4 impact-rated shingle. UL 2218 tested for hail resistance. Insurance premium discount.', tier:'best',
      oh:'OBC R905.2', ky:'KRC R905.2', irc:'IRC R905.2', ul:'UL 2218 Class 4',
      reason:'Impact-rated (Class 4) shingles required for hail-prone region. Qualifies for homeowner insurance discount.',
      tags:['shingle','gaf','impact','class4','hail-resistant'], insuranceDefault:true });
  A({ code:'RFG 240-GAF-CS', name:'GAF Timberline CS Cool Roof', sub:'shingles-cool', cat:'roofing', unit:'SQ', mat:135, lab:68,
      desc:'Cool roof shingle with ENERGY STAR reflectivity rating.', tier:'better',
      oh:'OBC R905.2', ky:'KRC R905.2', irc:'IRC R905.2',
      reason:'ENERGY STAR rated cool roof reduces cooling loads per OBC energy code.',
      tags:['shingle','gaf','cool','energy-star'] });

  // ── TAMKO impact-resistant lines (Titan XT / StormFighter FLEX / HailGuard) ──  PRICING TODO: mat/lab MIRRORED from the closest
  // GAF catalog line as a placeholder (Heritage←HD, Titan←HDZ, SFFlex/HailGuard
  // ←Armorshield, accessories←their GAF analog). Edit when real TAMKO sell
  // pricing is set. Codes contain "TAMKO" so generated docs detect manufacturer.
  A({ code:'RFG 240-TAMKO-HERITAGE', name:'TAMKO Heritage', sub:'shingles-arch', cat:'roofing', unit:'SQ', mat:95, lab:62,
      desc:'TAMKO architectural laminate (TriShield) — value tier.', tier:'good',
      oh:'OBC R905.2', ky:'KRC R905.2', irc:'IRC R905.2',
      reason:'Laminated asphalt shingles required per OBC R905.2.',
      tags:['shingle','tamko','architectural','laminated'] });
  A({ code:'RFG 240-TAMKO-TITAN', name:'TAMKO Titan XT (Impact Class 3)', sub:'shingles-impact', cat:'roofing', unit:'SQ', mat:115, lab:65,
      desc:'TAMKO impact-rated, UL 2218 Class 3. 160mph WindGuard with TAMKO starter + hip & ridge.', tier:'better',
      oh:'OBC R905.2', ky:'KRC R905.2', irc:'IRC R905.2.4', ul:'UL 2218 Class 3',
      reason:'Impact-rated (Class 3) shingles for hail-prone region.',
      tags:['shingle','tamko','impact','class3','wind-resistant'], insuranceDefault:true });
  A({ code:'RFG 240-TAMKO-SFFLEX', name:'TAMKO StormFighter Flex (Impact Class 4)', sub:'shingles-impact', cat:'roofing', unit:'SQ', mat:165, lab:72,
      desc:'TAMKO polymer-modified, UL 2218 Class 4. 160mph WindGuard with TAMKO starter + hip & ridge. Insurance premium discount.', tier:'best',
      oh:'OBC R905.2', ky:'KRC R905.2', irc:'IRC R905.2', ul:'UL 2218 Class 4',
      reason:'Impact-rated (Class 4) shingles for hail-prone region. Qualifies for homeowner insurance discount.',
      tags:['shingle','tamko','impact','class4','hail-resistant'], insuranceDefault:true });
  A({ code:'RFG 240-TAMKO-HAIL', name:'TAMKO HailGuard (Class 4, tested beyond)', sub:'shingles-impact', cat:'roofing', unit:'SQ', mat:165, lab:75,
      desc:'TAMKO ImpactCore, UL 2218 Class 4 (tested beyond). First asphalt shingle with a hail warranty. Requires TAMKO Synthetic Guard + Moisture Guard for warranty.', tier:'best',
      oh:'OBC R905.2', ky:'KRC R905.2', irc:'IRC R905.2', ul:'UL 2218 Class 4',
      reason:'Impact-rated (Class 4) shingles with hail warranty. Qualifies for homeowner insurance discount.',
      tags:['shingle','tamko','impact','class4','hail-resistant','hail-warranty'], insuranceDefault:true });
  // TAMKO warranty-required accessories
  A({ code:'RFG SYN-TAMKO', name:'TAMKO Synthetic Guard Underlayment', sub:'underlayment', cat:'roofing', unit:'SQ', mat:22, lab:12,
      desc:'TAMKO synthetic underlayment — required for TAMKO system warranties.', tier:'any',
      oh:'OBC R905.1.1', reason:'Underlayment required per OBC R905.1.1.',
      tags:['underlayment','synthetic','tamko'] });
  A({ code:'RFG IWS-TAMKO', name:'TAMKO Moisture Guard Ice & Water', sub:'underlayment', cat:'roofing', unit:'SQ', mat:85, lab:22,
      desc:'TAMKO ice & water shield — required for HailGuard warranty.', tier:'any',
      oh:'OBC R905.1.2', reason:'Ice barrier at eaves required per OBC R905.1.2.',
      tags:['underlayment','ice-shield','tamko'] });
  A({ code:'RFG STRT-TAMKO', name:'TAMKO Perforated Starter Strip', sub:'starter', cat:'roofing', unit:'LF', mat:1.85, lab:0.80,
      desc:'TAMKO starter strip — required for TAMKO 160mph wind warranty.', tier:'any',
      reason:'Starter strip per manufacturer spec for wind warranty.',
      tags:['starter','tamko'] });
  A({ code:'RFG RIDG-TAMKO', name:'TAMKO Hip & Ridge Shingles', sub:'ridge', cat:'roofing', unit:'LF', mat:4.25, lab:1.85,
      desc:'TAMKO hip & ridge cap — required for TAMKO 160mph wind warranty.', tier:'any',
      reason:'Ridge cap per manufacturer spec for wind warranty.',
      tags:['ridge','tamko'] });

  // GAF Designer
  A({ code:'RFG CAM2-GAF', name:'GAF Camelot II Designer', sub:'shingles-designer', cat:'roofing', unit:'SQ', mat:195, lab:85,
      desc:'Luxury designer shingle with artisan-crafted dimensional depth. Lifetime warranty.', tier:'best',
      oh:'OBC R905.2', ky:'KRC R905.2', irc:'IRC R905.2',
      reason:'Luxury designer shingle replacement matching original specification.',
      tags:['shingle','gaf','designer','luxury'] });
  A({ code:'RFG GS-GAF', name:'GAF Grand Sequoia', sub:'shingles-designer', cat:'roofing', unit:'SQ', mat:205, lab:88,
      tier:'best', oh:'OBC R905.2', ky:'KRC R905.2', irc:'IRC R905.2',
      reason:'Rugged wood-shake appearance shingle, lifetime limited warranty.',
      tags:['shingle','gaf','designer','wood-shake'] });
  A({ code:'RFG SL-GAF', name:'GAF Slateline', sub:'shingles-designer', cat:'roofing', unit:'SQ', mat:245, lab:95,
      desc:'Slate-look designer shingle with deep shadow lines.', tier:'best',
      oh:'OBC R905.2', ky:'KRC R905.2', irc:'IRC R905.2',
      reason:'Slate-appearance shingle, matches original slate roof aesthetic.',
      tags:['shingle','gaf','designer','slate-look'] });

  // Owens Corning
  A({ code:'RFG 240-OC-OAK', name:'Owens Corning Oakridge', sub:'shingles-arch', cat:'roofing', unit:'SQ', mat:95, lab:60,
      tier:'good', oh:'OBC R905.2', ky:'KRC R905.2', irc:'IRC R905.2',
      reason:'Basic architectural shingle replacement.',
      tags:['shingle','oc','architectural'] });
  A({ code:'RFG 240-OC-DUR', name:'Owens Corning Duration', sub:'shingles-arch', cat:'roofing', unit:'SQ', mat:110, lab:65,
      desc:'SureNail Technology for 130mph wind rating.', tier:'better',
      oh:'OBC R905.2', ky:'KRC R905.2', irc:'IRC R905.2.4',
      reason:'SureNail wind-resistant shingle installed per manufacturer spec.',
      tags:['shingle','oc','architectural','surenail'], insuranceDefault:true });
  A({ code:'RFG 240-OC-TRU', name:'Owens Corning TruDefinition Duration', sub:'shingles-arch', cat:'roofing', unit:'SQ', mat:120, lab:65,
      tier:'better', oh:'OBC R905.2', ky:'KRC R905.2', irc:'IRC R905.2',
      reason:'Premium color-blended architectural shingle.',
      tags:['shingle','oc','architectural','premium'] });
  A({ code:'RFG ARM-OC', name:'OC Duration Storm (Impact Class 4)', sub:'shingles-impact', cat:'roofing', unit:'SQ', mat:150, lab:72,
      desc:'Class 4 impact-rated with SureNail. Insurance premium discount qualifier.', tier:'best',
      oh:'OBC R905.2', ky:'KRC R905.2', irc:'IRC R905.2', ul:'UL 2218 Class 4',
      reason:'Impact-rated shingle qualifies for insurance premium discount (UL 2218 Class 4).',
      tags:['shingle','oc','impact','class4','hail-resistant'], insuranceDefault:true });
  A({ code:'RFG BK-OC', name:'OC Berkshire Designer', sub:'shingles-designer', cat:'roofing', unit:'SQ', mat:220, lab:90,
      desc:'Slate-inspired luxury shingle.', tier:'best',
      oh:'OBC R905.2', ky:'KRC R905.2', irc:'IRC R905.2',
      reason:'Luxury designer slate-look shingle.',
      tags:['shingle','oc','designer','luxury'] });

  // CertainTeed
  A({ code:'RFG 240-CT-LM', name:'CertainTeed Landmark', sub:'shingles-arch', cat:'roofing', unit:'SQ', mat:105, lab:62,
      tier:'good', oh:'OBC R905.2', ky:'KRC R905.2', irc:'IRC R905.2',
      reason:'Standard architectural shingle replacement.',
      tags:['shingle','certainteed','architectural'] });
  A({ code:'RFG 240-CT-LMP', name:'CertainTeed Landmark Pro', sub:'shingles-arch', cat:'roofing', unit:'SQ', mat:130, lab:68,
      desc:'Heavier weight architectural with Max Def colors.', tier:'better',
      oh:'OBC R905.2', ky:'KRC R905.2', irc:'IRC R905.2',
      reason:'Heavy-weight architectural shingle, enhanced UV stability.',
      tags:['shingle','certainteed','architectural','premium'] });
  A({ code:'RFG ARM-CT', name:'CertainTeed Landmark IR (Impact Class 4)', sub:'shingles-impact', cat:'roofing', unit:'SQ', mat:155, lab:72,
      tier:'best', oh:'OBC R905.2', ky:'KRC R905.2', irc:'IRC R905.2', ul:'UL 2218 Class 4',
      reason:'Impact-rated shingle for hail-prone region. Insurance discount eligible.',
      tags:['shingle','certainteed','impact','class4'], insuranceDefault:true });
  A({ code:'RFG PRES-CT', name:'CertainTeed Presidential Shake', sub:'shingles-designer', cat:'roofing', unit:'SQ', mat:225, lab:95,
      tier:'best', oh:'OBC R905.2', ky:'KRC R905.2', irc:'IRC R905.2',
      reason:'Premium shake-profile designer shingle.',
      tags:['shingle','certainteed','designer','shake'] });
  A({ code:'RFG GM-CT', name:'CertainTeed Grand Manor', sub:'shingles-designer', cat:'roofing', unit:'SQ', mat:265, lab:110,
      desc:'Top-tier luxury multi-layer shingle.', tier:'best',
      oh:'OBC R905.2', ky:'KRC R905.2', irc:'IRC R905.2',
      reason:'Luxury multi-layer shingle, matching original specification.',
      tags:['shingle','certainteed','designer','luxury','multi-layer'] });

  // Atlas
  A({ code:'RFG 240-ATL', name:'Atlas Pinnacle Pristine', sub:'shingles-arch', cat:'roofing', unit:'SQ', mat:115, lab:65,
      tier:'better', oh:'OBC R905.2', ky:'KRC R905.2', irc:'IRC R905.2',
      reason:'Scotchgard-protected architectural shingle resists algae staining.',
      tags:['shingle','atlas','architectural','scotchgard'] });
  A({ code:'RFG ARM-ATL', name:'Atlas StormMaster Shake (Impact Class 4)', sub:'shingles-impact', cat:'roofing', unit:'SQ', mat:160, lab:72,
      tier:'best', oh:'OBC R905.2', ky:'KRC R905.2', irc:'IRC R905.2', ul:'UL 2218 Class 4',
      reason:'Impact-rated polymer-modified shingle.',
      tags:['shingle','atlas','impact','class4'], insuranceDefault:true });

  // Malarkey
  A({ code:'RFG 240-MAL', name:'Malarkey Vista Architectural', sub:'shingles-arch', cat:'roofing', unit:'SQ', mat:100, lab:62,
      tier:'good', oh:'OBC R905.2', ky:'KRC R905.2', irc:'IRC R905.2',
      reason:'NEX polymer-modified asphalt shingle.',
      tags:['shingle','malarkey','architectural'] });
  A({ code:'RFG ARM-MAL', name:'Malarkey Highlander NEX (Impact Class 4)', sub:'shingles-impact', cat:'roofing', unit:'SQ', mat:155, lab:72,
      desc:'NEX rubberized asphalt, Class 4 impact resistance.', tier:'best',
      oh:'OBC R905.2', ky:'KRC R905.2', irc:'IRC R905.2', ul:'UL 2218 Class 4',
      reason:'Class 4 impact-rated shingle with polymer-modified asphalt for hail resistance.',
      tags:['shingle','malarkey','impact','class4','polymer'], insuranceDefault:true });

  // IKO
  A({ code:'RFG 240-IKO', name:'IKO Cambridge Architectural', sub:'shingles-arch', cat:'roofing', unit:'SQ', mat:90, lab:60,
      tier:'good', oh:'OBC R905.2', ky:'KRC R905.2', irc:'IRC R905.2',
      reason:'Economy architectural shingle replacement.',
      tags:['shingle','iko','architectural','economy'] });

  // Metal roofing
  A({ code:'RFG METAL-SS24', name:'Standing Seam Metal 24ga Steel', sub:'metal', cat:'roofing', unit:'SQ', mat:385, lab:225,
      desc:'Kynar-coated 24ga standing seam panels. 40yr finish warranty.', tier:'best',
      oh:'OBC R905.10', ky:'KRC R905.10', irc:'IRC R905.10',
      reason:'Standing seam metal roof installed per OBC R905.10 for metal panel roofing.',
      tags:['metal','standing-seam','steel','24ga'] });
  A({ code:'RFG METAL-SSAL', name:'Standing Seam Aluminum', sub:'metal', cat:'roofing', unit:'SQ', mat:425, lab:240,
      tier:'best', oh:'OBC R905.10', ky:'KRC R905.10', irc:'IRC R905.10',
      reason:'Aluminum standing seam for coastal/corrosion zones.',
      tags:['metal','standing-seam','aluminum'] });
  A({ code:'RFG METAL-GAL', name:'Standing Seam Galvalume', sub:'metal', cat:'roofing', unit:'SQ', mat:365, lab:225,
      tier:'better', oh:'OBC R905.10', ky:'KRC R905.10', irc:'IRC R905.10',
      reason:'Galvalume standing seam, budget metal option.',
      tags:['metal','standing-seam','galvalume'] });
  A({ code:'RFG METAL-SD', name:'Screw-Down Metal Panel 29ga', sub:'metal', cat:'roofing', unit:'SQ', mat:225, lab:165,
      desc:'Exposed fastener screw-down panel. Economical metal option.', tier:'good',
      oh:'OBC R905.10', ky:'KRC R905.10', irc:'IRC R905.10',
      reason:'Exposed-fastener metal roofing per OBC R905.10.',
      tags:['metal','screw-down','exposed-fastener','economy'] });
  A({ code:'RFG METAL-CORR', name:'Corrugated Metal 29ga', sub:'metal', cat:'roofing', unit:'SQ', mat:185, lab:155,
      tier:'good', oh:'OBC R905.10', ky:'KRC R905.10', irc:'IRC R905.10',
      reason:'Corrugated metal panel for outbuilding or agricultural use.',
      tags:['metal','corrugated','agricultural'] });
  A({ code:'RFG METAL-STN', name:'Stone-Coated Steel Tile', sub:'metal', cat:'roofing', unit:'SQ', mat:385, lab:245,
      desc:'Stone-chip-coated steel with tile profile. Lifetime warranty.', tier:'best',
      oh:'OBC R905.10', ky:'KRC R905.10', irc:'IRC R905.10',
      reason:'Stone-coated steel roof provides impact resistance + tile aesthetic.',
      tags:['metal','stone-coated','tile-profile'] });

  // Wood / Slate / Tile
  A({ code:'RFG CEDAR-SHK', name:'Cedar Shake (Hand-Split)', sub:'wood', cat:'roofing', unit:'SQ', mat:325, lab:225,
      tier:'best', oh:'OBC R905.7', ky:'KRC R905.7', irc:'IRC R905.7',
      reason:'Cedar shake roofing installed per OBC R905.7 with approved fire treatment.',
      tags:['cedar','shake','wood'] });
  A({ code:'RFG CEDAR-SHG', name:'Cedar Shingle (Sawn)', sub:'wood', cat:'roofing', unit:'SQ', mat:285, lab:185,
      tier:'better', oh:'OBC R905.8', ky:'KRC R905.8', irc:'IRC R905.8',
      reason:'Cedar shingle roofing per OBC R905.8.',
      tags:['cedar','shingle','wood'] });
  A({ code:'RFG TILE-CLAY', name:'Clay Tile Roofing', sub:'tile', cat:'roofing', unit:'SQ', mat:525, lab:325,
      desc:'Natural clay tile. 50+ year lifespan.', tier:'best',
      oh:'OBC R905.3', ky:'KRC R905.3', irc:'IRC R905.3',
      reason:'Clay tile installed per OBC R905.3 structural loading requirements.',
      tags:['tile','clay','natural'] });
  A({ code:'RFG TILE-CON', name:'Concrete Tile Roofing', sub:'tile', cat:'roofing', unit:'SQ', mat:385, lab:285,
      tier:'best', oh:'OBC R905.3', ky:'KRC R905.3', irc:'IRC R905.3',
      reason:'Concrete tile installed per OBC R905.3.',
      tags:['tile','concrete'] });
  A({ code:'RFG SLATE-NAT', name:'Natural Slate Roofing', sub:'slate', cat:'roofing', unit:'SQ', mat:785, lab:525,
      desc:'Premium natural slate, 100+ year lifespan.', tier:'best',
      oh:'OBC R905.6', ky:'KRC R905.6', irc:'IRC R905.6',
      reason:'Natural slate installed per OBC R905.6 with copper flashing.',
      tags:['slate','natural','luxury'] });
  A({ code:'RFG SLATE-SYN', name:'Synthetic Slate (Composite)', sub:'slate', cat:'roofing', unit:'SQ', mat:335, lab:195,
      tier:'best', oh:'OBC R905.6', ky:'KRC R905.6', irc:'IRC R905.6',
      reason:'Composite slate replicates natural slate at lower weight.',
      tags:['slate','synthetic','composite'] });

  // Membranes
  A({ code:'RFG TPO 60', name:'TPO Single-Ply Membrane 60mil', sub:'low-slope', cat:'roofing', unit:'SQ', mat:285, lab:185,
      desc:'Heat-welded seams. Energy Star white reflective.', tier:'better',
      oh:'OBC R905.11', ky:'KRC R905.11', irc:'IRC R905.11',
      reason:'Single-ply TPO for low-slope applications per OBC R905.11.',
      tags:['low-slope','tpo','membrane','60mil'] });
  A({ code:'RFG EPDM 60', name:'EPDM Rubber Roofing 60mil', sub:'low-slope', cat:'roofing', unit:'SQ', mat:225, lab:165,
      tier:'better', oh:'OBC R905.12', ky:'KRC R905.12', irc:'IRC R905.12',
      reason:'EPDM rubber membrane for low-slope per OBC R905.12.',
      tags:['low-slope','epdm','rubber','60mil'] });
  A({ code:'RFG MOD-BIT', name:'Modified Bitumen 2-Ply', sub:'low-slope', cat:'roofing', unit:'SQ', mat:285, lab:185,
      tier:'better', oh:'OBC R905.9', ky:'KRC R905.9', irc:'IRC R905.9',
      reason:'Modified bitumen 2-ply system per OBC R905.9.',
      tags:['low-slope','modified-bitumen','mod-bit','2-ply'] });
  A({ code:'RFG ROLLED', name:'Rolled Roofing (Mineral Surface)', sub:'low-slope', cat:'roofing', unit:'SQ', mat:135, lab:85,
      tier:'good', oh:'OBC R905.5', ky:'KRC R905.5', irc:'IRC R905.5',
      reason:'Mineral-surface rolled roofing for minimal slope per OBC R905.5.',
      tags:['low-slope','rolled','budget'] });

  // ═════════════════════════════════════════════════════════
  // 2. ROOFING — UNDERLAYMENT (10)
  // ═════════════════════════════════════════════════════════

  A({ code:'RFG 15F', name:'15lb Asphalt-Saturated Felt', sub:'underlayment', cat:'roofing', unit:'SQ', mat:15, lab:10,
      tier:'good', oh:'OBC R905.1.1', ky:'KRC R905.1.1', irc:'IRC R905.1.1',
      reason:'Minimum underlayment per OBC R905.1.1 for slopes 4:12 and greater.',
      tags:['underlayment','felt','15lb','budget'] });
  A({ code:'RFG 30F', name:'30lb Asphalt-Saturated Felt', sub:'underlayment', cat:'roofing', unit:'SQ', mat:22, lab:10,
      tier:'good', oh:'OBC R905.1.1', ky:'KRC R905.1.1', irc:'IRC R905.1.1',
      reason:'Heavy-duty felt for low-slope applications per OBC R905.1.1.',
      tags:['underlayment','felt','30lb'] });
  A({ code:'RFG SYN', name:'Synthetic Underlayment Standard', sub:'underlayment', cat:'roofing', unit:'SQ', mat:22, lab:12,
      desc:'Tear-resistant synthetic, replaces felt.', tier:'better',
      oh:'OBC R905.1.1', ky:'KRC R905.1.1', irc:'IRC R905.1.1',
      reason:'Synthetic underlayment meets OBC R905.1.1 requirements with enhanced tear strength.',
      tags:['underlayment','synthetic'], insuranceDefault:true });
  A({ code:'RFG SYN-P', name:'Premium Synthetic Underlayment', sub:'underlayment', cat:'roofing', unit:'SQ', mat:28, lab:12,
      desc:'GAF FeltBuster or equivalent. Enhanced walkability + UV stability.', tier:'better',
      oh:'OBC R905.1.1', ky:'KRC R905.1.1', irc:'IRC R905.1.1',
      reason:'Premium synthetic with OC Deck Defense or GAF Tiger Paw walking grip.',
      tags:['underlayment','synthetic','premium'] });
  A({ code:'RFG SYN-HT', name:'High-Temperature Synthetic Underlayment', sub:'underlayment', cat:'roofing', unit:'SQ', mat:38, lab:12,
      tier:'best', oh:'OBC R905.1.1', ky:'KRC R905.1.1', irc:'IRC R905.1.1',
      reason:'High-temp synthetic required under metal roofing applications.',
      tags:['underlayment','synthetic','high-temp','metal'] });
  A({ code:'RFG IWS', name:'Ice & Water Shield (Eave Protection)', sub:'underlayment', cat:'roofing', unit:'SQ', mat:85, lab:22,
      desc:'Self-adhering rubberized asphalt membrane.', tier:'any',
      oh:'OBC R905.1.2', ky:'KRC R905.1.2', irc:'IRC R905.1.2',
      reason:'REQUIRED by OBC R905.1.2: Ice barrier extending from eave to at least 24" inside the exterior wall line in areas where average January temperature ≤ 25°F. Cincinnati qualifies.',
      tags:['underlayment','ice-water','membrane','code-required'], insuranceDefault:true, requiresPhoto:true });
  A({ code:'RFG IWS-HT', name:'Ice & Water Shield High-Temp', sub:'underlayment', cat:'roofing', unit:'SQ', mat:110, lab:22,
      tier:'best', oh:'OBC R905.1.2', ky:'KRC R905.1.2', irc:'IRC R905.1.2',
      reason:'High-temp ice & water shield required at valleys and penetrations on metal roof systems.',
      tags:['underlayment','ice-water','high-temp','metal'] });
  A({ code:'RFG IWS-FC', name:'Full-Coverage Self-Adhered Underlayment', sub:'underlayment', cat:'roofing', unit:'SQ', mat:125, lab:25,
      desc:'100% self-adhered coverage for extreme weather or low-slope conditions.', tier:'best',
      oh:'OBC R905.1.2', ky:'KRC R905.1.2', irc:'IRC R905.1.2',
      reason:'Full-coverage self-adhered underlayment for high-wind zones and low-slope shingle applications.',
      tags:['underlayment','full-coverage','self-adhered','extreme'] });
  A({ code:'RFG VB-SYN', name:'Vapor-Barrier Synthetic Underlayment', sub:'underlayment', cat:'roofing', unit:'SQ', mat:32, lab:14,
      tier:'better', oh:'OBC R806', ky:'KRC R806', irc:'IRC R806',
      reason:'Vapor-barrier synthetic prevents moisture migration in unvented attic assemblies.',
      tags:['underlayment','synthetic','vapor-barrier'] });
  A({ code:'RFG RNB-MEM', name:'Rain & Ice Barrier Membrane', sub:'underlayment', cat:'roofing', unit:'SQ', mat:95, lab:22,
      tier:'best', oh:'OBC R905.1.2', ky:'KRC R905.1.2', irc:'IRC R905.1.2',
      reason:'Rain and ice barrier installed at eaves, valleys, and penetrations for enhanced leak protection.',
      tags:['underlayment','rain-ice','membrane'] });

  // ═════════════════════════════════════════════════════════
  // 3. ROOFING — STARTER & RIDGE (8)
  // ═════════════════════════════════════════════════════════

  A({ code:'RFG STRT', name:'Starter Strip Shingles', sub:'starter', cat:'roofing', unit:'LF', mat:1.85, lab:0.80,
      desc:'Factory-cut starter strip with peel-and-stick adhesive.', tier:'any',
      oh:'OBC R905.2', ky:'KRC R905.2', irc:'IRC R905.2',
      reason:'Starter course required per shingle manufacturer specification for wind warranty.',
      tags:['starter','accessories'], insuranceDefault:true });
  A({ code:'RFG STRT-PS', name:'Peel-and-Stick Starter Strip Premium', sub:'starter', cat:'roofing', unit:'LF', mat:2.15, lab:0.80,
      tier:'better', reason:'Premium peel-and-stick starter for enhanced wind adhesion.',
      tags:['starter','peel-stick','premium'] });
  A({ code:'RFG RIDG', name:'Ridge Cap Shingles (3-Tab Cut)', sub:'ridge', cat:'roofing', unit:'LF', mat:3.85, lab:1.85,
      tier:'good', oh:'OBC R905.2', ky:'KRC R905.2', irc:'IRC R905.2',
      reason:'Ridge cap required at ridge to seal roof.',
      tags:['ridge','cap','3-tab'] });
  A({ code:'RFG RIDG-ARC', name:'Ridge Cap Shingles Architectural', sub:'ridge', cat:'roofing', unit:'LF', mat:4.25, lab:1.85,
      desc:'Factory-formed architectural ridge cap (TimberTex / Ridglass / Mountain Ridge).', tier:'better',
      oh:'OBC R905.2', ky:'KRC R905.2', irc:'IRC R905.2',
      reason:'Architectural ridge cap matches field shingles and provides enhanced wind warranty.',
      tags:['ridge','cap','architectural'], insuranceDefault:true });
  A({ code:'RFG RIDG-PRE', name:'Premium Designer Ridge Cap', sub:'ridge', cat:'roofing', unit:'LF', mat:5.85, lab:1.85,
      tier:'best', reason:'Premium hip/ridge matches designer shingle field.',
      tags:['ridge','cap','designer','premium'] });
  A({ code:'RFG RIDG-IMP', name:'Impact-Rated Ridge Cap', sub:'ridge', cat:'roofing', unit:'LF', mat:5.50, lab:1.85,
      tier:'best', reason:'Impact-rated ridge cap matches Class 4 impact field shingles.',
      tags:['ridge','cap','impact','class4'] });
  A({ code:'RFG HIPC', name:'Hip Cap Shingles', sub:'hip', cat:'roofing', unit:'LF', mat:4.25, lab:1.85,
      tier:'any', reason:'Hip cap required at hip junctions.',
      tags:['hip','cap'] });
  A({ code:'RFG HIPC-PRE', name:'Hip Cap Shingles Designer', sub:'hip', cat:'roofing', unit:'LF', mat:5.85, lab:1.85,
      tier:'best', reason:'Designer hip cap matches luxury shingle field.',
      tags:['hip','cap','designer'] });

  // ═════════════════════════════════════════════════════════
  // 4. ROOFING — DRIP EDGE & RAKE METAL (6)
  // ═════════════════════════════════════════════════════════

  A({ code:'RFG DRPE-AL', name:'Drip Edge Aluminum (F-Style)', sub:'drip-edge', cat:'roofing', unit:'LF', mat:1.95, lab:0.65,
      desc:'F-style aluminum drip edge, mill finish or painted.', tier:'any',
      oh:'OBC R905.2.8.5', ky:'KRC R905.2.8.5', irc:'IRC R905.2.8.5',
      reason:'Drip edge required at eaves and rakes per OBC R905.2.8.5 (adopted 2019).',
      tags:['drip-edge','aluminum','code-required'], insuranceDefault:true, requiresPhoto:true });
  A({ code:'RFG DRPE-ST', name:'Drip Edge Galvanized Steel', sub:'drip-edge', cat:'roofing', unit:'LF', mat:1.75, lab:0.65,
      tier:'good', oh:'OBC R905.2.8.5', ky:'KRC R905.2.8.5', irc:'IRC R905.2.8.5',
      reason:'Drip edge required per OBC R905.2.8.5.',
      tags:['drip-edge','steel'] });
  A({ code:'RFG DRPE-CU', name:'Drip Edge Copper', sub:'drip-edge', cat:'roofing', unit:'LF', mat:8.85, lab:1.25,
      tier:'best', reason:'Copper drip edge for historic district restoration.',
      tags:['drip-edge','copper','historic'] });
  A({ code:'RFG RAKE-AL', name:'Rake Metal Aluminum', sub:'rake', cat:'roofing', unit:'LF', mat:1.95, lab:0.65,
      tier:'any', reason:'Rake metal required at gable ends per OBC R905.2.8.5.',
      tags:['rake','metal','aluminum'] });
  A({ code:'RFG GAPR', name:'Gutter Apron (F-5 Profile)', sub:'gutter-apron', cat:'roofing', unit:'LF', mat:2.25, lab:0.85,
      desc:'F-5 profile gutter apron directs water into gutter.', tier:'better',
      oh:'OBC R905.2.8.5', ky:'KRC R905.2.8.5', irc:'IRC R905.2.8.5',
      reason:'Gutter apron directs water behind drip edge into gutter, preventing fascia rot.',
      tags:['gutter-apron','f5','metal'] });
  A({ code:'RFG TMETAL', name:'T-Style Transition Metal', sub:'transition', cat:'roofing', unit:'LF', mat:3.85, lab:1.25,
      tier:'better', reason:'T-style metal at roof transitions for watershed.',
      tags:['transition','metal','custom'] });

  // ═════════════════════════════════════════════════════════
  // 5. ROOFING — FLASHING (18)
  // ═════════════════════════════════════════════════════════

  A({ code:'RFG STPF-AL', name:'Step Flashing Aluminum', sub:'flashing', cat:'roofing', unit:'EA', mat:0.75, lab:1.25,
      desc:'Pre-bent L-shaped aluminum step flashing 4"x4"x8".', tier:'any',
      oh:'OBC R903.2', ky:'KRC R903.2', irc:'IRC R903.2',
      reason:'Step flashing required at roof-to-wall intersections per OBC R903.2.',
      tags:['flashing','step','aluminum','code-required'], insuranceDefault:true, requiresPhoto:true });
  A({ code:'RFG STPF-CU', name:'Step Flashing Copper', sub:'flashing', cat:'roofing', unit:'EA', mat:4.85, lab:1.85,
      tier:'best', reason:'Copper step flashing for historic or slate installations.',
      tags:['flashing','step','copper','historic'] });
  A({ code:'RFG CNTR', name:'Counter Flashing', sub:'flashing', cat:'roofing', unit:'LF', mat:3.85, lab:4.65,
      desc:'Reglet counter-flashing set into masonry mortar joint.', tier:'any',
      oh:'OBC R903.2', ky:'KRC R903.2', irc:'IRC R903.2',
      reason:'Counter-flashing required over step flashing at masonry walls per OBC R903.2.',
      tags:['flashing','counter','masonry'], insuranceDefault:true });
  A({ code:'RFG CHIM-STD', name:'Chimney Flashing Kit (Standard)', sub:'flashing', cat:'roofing', unit:'EA', mat:125, lab:160,
      desc:'Full chimney flash kit: apron, step, counter, saddle.', tier:'any',
      oh:'OBC R903.2', ky:'KRC R903.2', irc:'IRC R903.2',
      reason:'Complete chimney flashing per OBC R903.2 required to prevent leaks.',
      tags:['flashing','chimney','kit'], insuranceDefault:true, requiresPhoto:true });
  A({ code:'RFG CHIM-SAD', name:'Chimney Saddle / Cricket (24" wide)', sub:'flashing', cat:'roofing', unit:'EA', mat:185, lab:225,
      desc:'Custom-fab chimney saddle (cricket) required for chimneys >30" wide.', tier:'any',
      oh:'OBC R1003.20', ky:'KRC R1003.20', irc:'IRC R1003.20',
      reason:'Chimney cricket REQUIRED per OBC R1003.20 for chimneys greater than 30 inches wide measured perpendicular to the slope.',
      tags:['flashing','chimney','cricket','saddle','code-required'], insuranceDefault:true, requiresPhoto:true });
  A({ code:'RFG SKY-STD', name:'Skylight Flashing Kit (Standard)', sub:'flashing', cat:'roofing', unit:'EA', mat:165, lab:185,
      tier:'any', oh:'OBC R903.2', ky:'KRC R903.2', irc:'IRC R903.2',
      reason:'Skylight flashing required per manufacturer specification and OBC R903.2.',
      tags:['flashing','skylight','kit'], insuranceDefault:true });
  A({ code:'RFG SKY-CUS', name:'Skylight Flashing Custom (Tempered)', sub:'flashing', cat:'roofing', unit:'EA', mat:285, lab:225,
      tier:'best', reason:'Custom-fab flashing for non-standard skylight sizes.',
      tags:['flashing','skylight','custom','tempered'] });
  A({ code:'RFG VLY-W', name:'Valley Metal W-Profile', sub:'valley', cat:'roofing', unit:'LF', mat:3.85, lab:4.65,
      desc:'Galvanized W-profile open valley metal.', tier:'better',
      oh:'OBC R905.2', ky:'KRC R905.2', irc:'IRC R905.2',
      reason:'W-profile valley metal provides positive watershed per NRCA guidelines.',
      tags:['valley','metal','w-profile'], insuranceDefault:true });
  A({ code:'RFG VLY-OPN', name:'Valley Metal Open-Style Aluminum', sub:'valley', cat:'roofing', unit:'LF', mat:4.25, lab:4.65,
      tier:'better', reason:'Open valley metal provides positive drainage.',
      tags:['valley','metal','open','aluminum'] });
  A({ code:'RFG VLY-CLS', name:'Closed Valley (Woven)', sub:'valley', cat:'roofing', unit:'LF', mat:0, lab:3.25,
      desc:'Woven closed valley — labor only, uses field shingles.', tier:'good',
      reason:'Closed woven valley per NRCA low-cost alternative.',
      tags:['valley','closed','woven','labor-only'] });
  A({ code:'RFG PIPE-STD', name:'Pipe Boot / Plumbing Vent Flashing', sub:'flashing', cat:'roofing', unit:'EA', mat:18, lab:28,
      desc:'Standard neoprene-collared aluminum pipe flashing.', tier:'good',
      oh:'OBC R903.2', ky:'KRC R903.2', irc:'IRC R903.2',
      reason:'Pipe flashing required at plumbing penetrations per OBC R903.2.',
      tags:['flashing','pipe','boot','neoprene'] });
  A({ code:'RFG PIPE-LD', name:'Pipe Boot Lead', sub:'flashing', cat:'roofing', unit:'EA', mat:42, lab:32,
      tier:'better', reason:'Lead pipe flashing for longevity and hail resistance.',
      tags:['flashing','pipe','boot','lead'] });
  A({ code:'RFG PIPE-RTR', name:'Pipe Boot Retrofit Sleeve', sub:'flashing', cat:'roofing', unit:'EA', mat:28, lab:22,
      desc:'Retrofit sleeve for repair without removing shingles.', tier:'good',
      reason:'Retrofit sleeve repairs deteriorated pipe boot without full flashing replacement.',
      tags:['flashing','pipe','retrofit','repair'] });
  A({ code:'RFG HDWL', name:'Headwall Flashing (Apron)', sub:'flashing', cat:'roofing', unit:'LF', mat:3.85, lab:4.65,
      desc:'Apron/headwall flashing at roof-to-vertical-wall transition.', tier:'any',
      oh:'OBC R903.2', ky:'KRC R903.2', irc:'IRC R903.2',
      reason:'Headwall flashing required where roof abuts vertical wall per OBC R903.2.',
      tags:['flashing','headwall','apron'], insuranceDefault:true });
  A({ code:'RFG SDWL', name:'Sidewall Flashing', sub:'flashing', cat:'roofing', unit:'LF', mat:3.25, lab:4.25,
      tier:'any', oh:'OBC R903.2', ky:'KRC R903.2', irc:'IRC R903.2',
      reason:'Sidewall flashing required at roof-to-wall transitions.',
      tags:['flashing','sidewall'] });
  A({ code:'RFG PARAP', name:'Parapet Cap Flashing', sub:'flashing', cat:'roofing', unit:'LF', mat:5.85, lab:6.25,
      tier:'any', oh:'OBC R903.2', ky:'KRC R903.2', irc:'IRC R903.2',
      reason:'Parapet cap flashing required on commercial/low-slope assemblies.',
      tags:['flashing','parapet','cap','commercial'] });
  A({ code:'RFG KICK', name:'Kickout Flashing (Diverter)', sub:'flashing', cat:'roofing', unit:'EA', mat:8.50, lab:28,
      desc:'Kickout diverter at lower roof/wall termination.', tier:'any',
      oh:'OBC R903.2.1', ky:'KRC R903.2.1', irc:'IRC R903.2.1',
      reason:'REQUIRED by OBC R903.2.1: Kickout flashing at lower roof-to-wall terminations to prevent water intrusion behind siding.',
      tags:['flashing','kickout','diverter','code-required'], insuranceDefault:true, requiresPhoto:true });
  A({ code:'RFG CORNR', name:'Corner Flashing Custom', sub:'flashing', cat:'roofing', unit:'LF', mat:4.85, lab:5.85,
      tier:'better', reason:'Custom-bent corner flashing for unique roof-to-wall conditions.',
      tags:['flashing','corner','custom'] });

  // ═════════════════════════════════════════════════════════
  // 6. ROOFING — VENTILATION (18)
  // ═════════════════════════════════════════════════════════

  A({ code:'RFG RIDG-VNT', name:'Ridge Vent Aluminum', sub:'ventilation', cat:'roofing', unit:'LF', mat:3.25, lab:1.50,
      desc:'Continuous aluminum ridge vent with external baffle.', tier:'any',
      oh:'OBC R806', ky:'KRC R806', irc:'IRC R806',
      reason:'Required attic ventilation per OBC R806 — 1 sq ft NFA per 150 sq ft attic (1:150 ratio) or 1:300 with balanced intake/exhaust.',
      tags:['ventilation','ridge-vent','aluminum','code-required'], insuranceDefault:true });
  A({ code:'RFG RIDG-VNT-PL', name:'Ridge Vent Plastic (Low-Profile)', sub:'ventilation', cat:'roofing', unit:'LF', mat:2.85, lab:1.50,
      tier:'good', oh:'OBC R806', ky:'KRC R806', irc:'IRC R806',
      reason:'Low-profile ridge vent meets OBC R806 attic ventilation requirements.',
      tags:['ventilation','ridge-vent','plastic'] });
  A({ code:'RFG RIDG-VNT-PR', name:'Premium Ridge Vent (Hail-Resistant)', sub:'ventilation', cat:'roofing', unit:'LF', mat:6.50, lab:1.50,
      desc:'Hail-resistant ridge vent (RoofIVent FLOW or GAF Cobra).', tier:'best',
      oh:'OBC R806', ky:'KRC R806', irc:'IRC R806',
      reason:'Premium hail-resistant ridge vent for impact-prone region.',
      tags:['ventilation','ridge-vent','premium','hail-resistant'] });
  A({ code:'RFG BOX-STD', name:'Box Vent / Turtle Vent (Standard)', sub:'ventilation', cat:'roofing', unit:'EA', mat:18, lab:25,
      tier:'good', oh:'OBC R806', ky:'KRC R806', irc:'IRC R806',
      reason:'Static box vents for attic exhaust ventilation.',
      tags:['ventilation','box-vent','turtle'] });
  A({ code:'RFG BOX-PRE', name:'Premium Hail-Resistant Box Vent', sub:'ventilation', cat:'roofing', unit:'EA', mat:42, lab:25,
      tier:'best', reason:'Premium polypropylene hail-resistant box vent.',
      tags:['ventilation','box-vent','hail-resistant'] });
  A({ code:'RFG PWR', name:'Power Vent Roof-Mounted', sub:'ventilation', cat:'roofing', unit:'EA', mat:185, lab:125,
      desc:'Thermostat-controlled power attic ventilator.', tier:'better',
      oh:'OBC R806', ky:'KRC R806', irc:'IRC R806',
      reason:'Active power ventilation meets OBC R806 attic cooling requirements.',
      tags:['ventilation','power-vent','active','electrical'] });
  A({ code:'RFG SOLAR', name:'Solar Attic Vent', sub:'ventilation', cat:'roofing', unit:'EA', mat:285, lab:125,
      desc:'Solar-powered attic fan, no electrical hookup required.', tier:'best',
      oh:'OBC R806', ky:'KRC R806', irc:'IRC R806',
      reason:'Solar attic fan — energy-efficient alternative to power vent, no electrician needed.',
      tags:['ventilation','solar','active','energy-star'] });
  A({ code:'RFG TURB', name:'Turbine Vent 12" Wind-Driven', sub:'ventilation', cat:'roofing', unit:'EA', mat:45, lab:45,
      tier:'good', reason:'Wind-driven turbine vent for attic exhaust.',
      tags:['ventilation','turbine','wind-driven'] });
  A({ code:'RFG TURB14', name:'Turbine Vent 14" Heavy-Duty', sub:'ventilation', cat:'roofing', unit:'EA', mat:65, lab:48,
      tier:'better', reason:'Heavy-duty 14" turbine for larger attic volumes.',
      tags:['ventilation','turbine','14-inch'] });
  A({ code:'RFG SFT-C', name:'Soffit Vent Continuous (8" strip)', sub:'ventilation', cat:'roofing', unit:'LF', mat:2.85, lab:1.85,
      desc:'Continuous aluminum soffit vent strip.', tier:'any',
      oh:'OBC R806', ky:'KRC R806', irc:'IRC R806',
      reason:'Continuous soffit intake ventilation required for balanced 1:300 ventilation ratio per OBC R806.',
      tags:['ventilation','soffit','continuous','intake'], insuranceDefault:true });
  A({ code:'RFG SFT-I', name:'Soffit Vent Individual 8x16', sub:'ventilation', cat:'roofing', unit:'EA', mat:8.50, lab:12,
      tier:'good', oh:'OBC R806', ky:'KRC R806', irc:'IRC R806',
      reason:'Individual soffit vents for balanced intake ventilation.',
      tags:['ventilation','soffit','individual','8x16'] });
  A({ code:'RFG SMT', name:'SmartVent / EdgeVent Intake (Shingle-Over)', sub:'ventilation', cat:'roofing', unit:'LF', mat:8.50, lab:2.25,
      desc:'Shingle-over intake vent for homes without soffits.', tier:'best',
      oh:'OBC R806', ky:'KRC R806', irc:'IRC R806',
      reason:'Shingle-over intake vent provides R806 intake ventilation where soffits are absent.',
      tags:['ventilation','smartvent','edgevent','intake','shingle-over'] });
  A({ code:'RFG GBL', name:'Gable Vent Rectangular (12x18)', sub:'ventilation', cat:'roofing', unit:'EA', mat:35, lab:45,
      tier:'good', reason:'Rectangular gable vent — budget ventilation.',
      tags:['ventilation','gable','rectangular'] });
  A({ code:'RFG GBL-OCT', name:'Gable Vent Octagonal Decorative', sub:'ventilation', cat:'roofing', unit:'EA', mat:125, lab:65,
      tier:'best', reason:'Decorative octagonal gable vent for aesthetic appeal.',
      tags:['ventilation','gable','octagonal','decorative'] });
  A({ code:'RFG GBL-RND', name:'Gable Vent Round Decorative', sub:'ventilation', cat:'roofing', unit:'EA', mat:145, lab:65,
      tier:'best', reason:'Decorative round gable vent.',
      tags:['ventilation','gable','round','decorative'] });
  A({ code:'RFG CUP', name:'Cupola Vent Assembly', sub:'ventilation', cat:'roofing', unit:'EA', mat:385, lab:225,
      tier:'best', reason:'Decorative cupola provides ridge-style exhaust ventilation.',
      tags:['ventilation','cupola','decorative','premium'] });
  A({ code:'RFG HIP-VNT', name:'Hip Vent (Continuous)', sub:'ventilation', cat:'roofing', unit:'LF', mat:5.85, lab:2.25,
      desc:'Continuous hip vent for hip-roof ventilation.', tier:'better',
      reason:'Hip vent provides exhaust ventilation on hip roofs where ridge vents are not applicable.',
      tags:['ventilation','hip-vent','continuous'] });
  A({ code:'RFG BFL', name:'Ridge Vent Baffle / Underlayment', sub:'ventilation', cat:'roofing', unit:'LF', mat:1.25, lab:0.85,
      tier:'any', reason:'External baffle required for proper ridge vent function.',
      tags:['ventilation','baffle','ridge-vent'] });

  // ═════════════════════════════════════════════════════════
  // 7. ROOFING — DECKING (12)
  // ═════════════════════════════════════════════════════════

  A({ code:'RFG OSB716', name:'OSB Decking 7/16" × 4×8 Sheet', sub:'decking', cat:'roofing', unit:'SF', mat:0.85, lab:0.85,
      tier:'good', oh:'OBC R803', ky:'KRC R803', irc:'IRC R803',
      reason:'Roof deck replacement per OBC R803 minimum sheathing thickness.',
      tags:['decking','osb','7/16','sheathing'], insuranceDefault:true });
  A({ code:'RFG OSB12', name:'OSB Decking 1/2" × 4×8 Sheet', sub:'decking', cat:'roofing', unit:'SF', mat:0.95, lab:0.85,
      tier:'better', oh:'OBC R803', ky:'KRC R803', irc:'IRC R803',
      reason:'1/2" OSB exceeds minimum sheathing per OBC R803 for enhanced nail holding.',
      tags:['decking','osb','1/2','sheathing'] });
  A({ code:'RFG OSB58', name:'OSB Decking 5/8" × 4×8 Sheet', sub:'decking', cat:'roofing', unit:'SF', mat:1.15, lab:0.95,
      tier:'best', oh:'OBC R803', ky:'KRC R803', irc:'IRC R803',
      reason:'5/8" OSB for enhanced structural integrity in high-wind zones.',
      tags:['decking','osb','5/8','structural'] });
  A({ code:'RFG PLY12', name:'Plywood 1/2" CDX × 4×8 Sheet', sub:'decking', cat:'roofing', unit:'SF', mat:1.45, lab:0.85,
      tier:'better', oh:'OBC R803', ky:'KRC R803', irc:'IRC R803',
      reason:'CDX plywood sheathing, enhanced nail retention vs OSB.',
      tags:['decking','plywood','cdx','1/2'] });
  A({ code:'RFG PLY58', name:'Plywood 5/8" CDX', sub:'decking', cat:'roofing', unit:'SF', mat:1.85, lab:0.95,
      tier:'best', oh:'OBC R803', ky:'KRC R803', irc:'IRC R803',
      reason:'5/8" CDX plywood for structural repairs.',
      tags:['decking','plywood','cdx','5/8'] });
  A({ code:'RFG PLY34', name:'Plywood 3/4" CDX', sub:'decking', cat:'roofing', unit:'SF', mat:2.25, lab:1.15,
      tier:'best', reason:'3/4" CDX plywood for heavy structural repairs.',
      tags:['decking','plywood','cdx','3/4'] });
  A({ code:'RFG TG34', name:'Plywood 3/4" T&G Tongue & Groove', sub:'decking', cat:'roofing', unit:'SF', mat:2.65, lab:1.35,
      tier:'best', reason:'Tongue & groove plywood for enhanced seam strength.',
      tags:['decking','plywood','tongue-groove','t&g'] });
  A({ code:'RFG BRD', name:'Board Decking Replacement (1x6 Pine)', sub:'decking', cat:'roofing', unit:'LF', mat:2.25, lab:1.85,
      tier:'any', reason:'Board decking replacement matching existing construction.',
      tags:['decking','board','pine','legacy'] });
  A({ code:'RFG STRUCT', name:'Structural Repair (Rafter/Truss)', sub:'decking', cat:'roofing', unit:'HR', mat:15, lab:85,
      desc:'Sistering or replacing damaged rafter / truss member.', tier:'any',
      oh:'OBC R802', ky:'KRC R802', irc:'IRC R802',
      reason:'Structural framing repair required per OBC R802 for damaged rafters or trusses. Engineering letter may be required.',
      tags:['decking','structural','rafter','truss','framing'], requiresPhoto:true });
  A({ code:'RFG ROTR', name:'Rot Repair Decking (Per SF Extra)', sub:'decking', cat:'roofing', unit:'SF', mat:0.50, lab:1.85,
      desc:'Additional labor for cutting out and replacing rotted deck.', tier:'any',
      reason:'Rot repair charge for additional removal/prep labor on deteriorated sheathing.',
      tags:['decking','rot','repair','demo'], requiresPhoto:true });
  A({ code:'RFG CLIPS', name:'H-Clips Sheathing Clips', sub:'decking', cat:'roofing', unit:'EA', mat:0.15, lab:0.05,
      tier:'any', oh:'OBC R803', ky:'KRC R803', irc:'IRC R803',
      reason:'H-clips required between rafters per OBC R803 for sheathing span support.',
      tags:['decking','clips','h-clip'] });
  A({ code:'RFG FBLK', name:'Fire Blocking at Roof Transitions', sub:'decking', cat:'roofing', unit:'LF', mat:1.85, lab:3.25,
      tier:'any', oh:'OBC R302.11', ky:'KRC R302.11', irc:'IRC R302.11',
      reason:'Fire blocking required at roof transitions per OBC R302.11.',
      tags:['decking','fire-blocking','code-required'] });

  // ═════════════════════════════════════════════════════════
  // 8. ROOFING — FASTENERS (6)
  // ═════════════════════════════════════════════════════════

  A({ code:'RFG NAIL-C', name:'Coil Roofing Nails Standard', sub:'fasteners', cat:'roofing', unit:'SQ', mat:4.50, lab:0,
      tier:'any', oh:'OBC R905.2.5', ky:'KRC R905.2.5', irc:'IRC R905.2.5',
      reason:'Corrosion-resistant roofing nails required per OBC R905.2.5 minimum 6 nails per shingle for high-wind zones.',
      tags:['fasteners','nails','coil'] });
  A({ code:'RFG NAIL-CAP', name:'Cap Nails for Synthetic Underlayment', sub:'fasteners', cat:'roofing', unit:'SQ', mat:3.25, lab:0,
      tier:'better', reason:'Plastic cap nails required by most synthetic underlayment manufacturers.',
      tags:['fasteners','cap-nails','synthetic'] });
  A({ code:'RFG NAIL-R', name:'Ring-Shank Roofing Nails (Generic)', sub:'fasteners', cat:'roofing', unit:'SQ', mat:8.85, lab:0,
      tier:'best', reason:'Ring-shank nails provide 40% more pullout resistance for wind zones.',
      tags:['fasteners','ring-shank','wind-resistant'] });
  A({ code:'RFG NAIL-LUMA', name:'LumaNails Ring-Shank Fasteners', sub:'fasteners', cat:'roofing', unit:'SQ', mat:7.50, lab:0,
      desc:'LumaNails premium ring-shank roofing nails. One box covers about 10 SQ of installation.',
      tier:'best',
      reason:'LumaNails engineered ring-shank fasteners with enhanced pullout resistance. Joe\'s preferred fastener for Best-tier systems.',
      tags:['fasteners','lumanails','ring-shank','best-tier','premium'],
      packaging: { unit: 'Box', coverage: 10, coverageUnit: 'SQ', costPerBox: 75 } });
  A({ code:'RFG NAIL-SS', name:'Stainless Steel Roofing Nails', sub:'fasteners', cat:'roofing', unit:'SQ', mat:18, lab:0,
      tier:'best', reason:'Stainless steel nails for cedar/metal/slate applications to prevent staining.',
      tags:['fasteners','stainless','cedar','metal'] });
  A({ code:'RFG SCRW-M', name:'Metal Roof Screws with Neoprene Washer', sub:'fasteners', cat:'roofing', unit:'EA', mat:0.35, lab:0.02,
      tier:'any', reason:'Neoprene-washered screws for metal panel installation.',
      tags:['fasteners','screws','metal','neoprene'] });
  A({ code:'RFG CAP-P', name:'Plastic Cap for Ice & Water Shield', sub:'fasteners', cat:'roofing', unit:'EA', mat:0.08, lab:0.01,
      tier:'any', reason:'Plastic cap fasteners for ice & water shield mechanical attachment.',
      tags:['fasteners','plastic-cap','ice-water'] });

  // ═════════════════════════════════════════════════════════
  // 9. GUTTERS & DRAINAGE (22)
  // ═════════════════════════════════════════════════════════

  A({ code:'GTR 5K-AL', name:'Gutter 5" K-Style Aluminum Seamless', sub:'gutters', cat:'gutters', unit:'LF', mat:4.85, lab:3.65,
      desc:'Seamless aluminum 5" K-style gutter with baked enamel finish.', tier:'good',
      reason:'5" K-style aluminum gutter, standard residential profile.',
      tags:['gutter','5-inch','k-style','aluminum','seamless'], insuranceDefault:true });
  A({ code:'GTR 5K-ST', name:'Gutter 5" K-Style Galvanized Steel', sub:'gutters', cat:'gutters', unit:'LF', mat:5.85, lab:3.85,
      tier:'better', reason:'Galvanized steel 5" K-style for impact zones.',
      tags:['gutter','5-inch','k-style','steel'] });
  A({ code:'GTR 5K-CU', name:'Gutter 5" K-Style Copper', sub:'gutters', cat:'gutters', unit:'LF', mat:18.50, lab:5.85,
      tier:'best', reason:'Copper 5" gutter for historic or luxury installations.',
      tags:['gutter','5-inch','k-style','copper','historic'] });
  A({ code:'GTR 6K-AL', name:'Gutter 6" K-Style Aluminum Seamless', sub:'gutters', cat:'gutters', unit:'LF', mat:5.45, lab:4.05,
      desc:'6" aluminum gutter handles 40% more water than 5".', tier:'better',
      reason:'6" K-style gutter for high-capacity roof areas (steep or large).',
      tags:['gutter','6-inch','k-style','aluminum','high-capacity'], insuranceDefault:true });
  A({ code:'GTR 6K-ST', name:'Gutter 6" K-Style Galvanized Steel', sub:'gutters', cat:'gutters', unit:'LF', mat:6.85, lab:4.25,
      tier:'best', reason:'6" galvanized steel gutter for heavy-duty applications.',
      tags:['gutter','6-inch','k-style','steel'] });
  A({ code:'GTR 6K-CU', name:'Gutter 6" K-Style Copper', sub:'gutters', cat:'gutters', unit:'LF', mat:22.50, lab:6.25,
      tier:'best', reason:'Copper 6" gutter for historic luxury installations.',
      tags:['gutter','6-inch','k-style','copper'] });
  A({ code:'GTR HR-AL', name:'Gutter Half-Round Aluminum 5"', sub:'gutters', cat:'gutters', unit:'LF', mat:6.85, lab:4.25,
      tier:'better', reason:'Half-round aluminum for traditional architectural styles.',
      tags:['gutter','half-round','aluminum','traditional'] });
  A({ code:'GTR HR-CU', name:'Gutter Half-Round Copper 5"', sub:'gutters', cat:'gutters', unit:'LF', mat:24.50, lab:6.25,
      tier:'best', reason:'Copper half-round for premium historic restoration.',
      tags:['gutter','half-round','copper','historic'] });
  A({ code:'GTR BOX-AL', name:'Gutter Box-Style Aluminum', sub:'gutters', cat:'gutters', unit:'LF', mat:9.85, lab:4.85,
      tier:'best', reason:'Custom box gutter for commercial or modern residential.',
      tags:['gutter','box','aluminum','commercial'] });
  A({ code:'GTR DSP23-AL', name:'Downspout 2x3 Aluminum', sub:'downspout', cat:'gutters', unit:'LF', mat:3.25, lab:1.85,
      tier:'good', reason:'Standard residential 2x3 aluminum downspout.',
      tags:['downspout','2x3','aluminum'] });
  A({ code:'GTR DSP34-AL', name:'Downspout 3x4 Aluminum', sub:'downspout', cat:'gutters', unit:'LF', mat:4.15, lab:2.15,
      tier:'better', reason:'3x4 downspout for higher water volume.',
      tags:['downspout','3x4','aluminum'] });
  A({ code:'GTR DSP34-ST', name:'Downspout 3x4 Galvanized Steel', sub:'downspout', cat:'gutters', unit:'LF', mat:5.25, lab:2.15,
      tier:'better', reason:'Steel 3x4 downspout for impact-prone areas.',
      tags:['downspout','3x4','steel'] });
  A({ code:'GTR DSP-RD', name:'Downspout Round Aluminum 4"', sub:'downspout', cat:'gutters', unit:'LF', mat:7.85, lab:2.85,
      tier:'better', reason:'Round downspout for traditional/half-round gutter match.',
      tags:['downspout','round','aluminum'] });
  A({ code:'GTR DSP-CU', name:'Downspout Copper 3x4', sub:'downspout', cat:'gutters', unit:'LF', mat:18.50, lab:3.85,
      tier:'best', reason:'Copper downspout for historic restoration match.',
      tags:['downspout','copper','historic'] });
  A({ code:'GTR GG-MESH', name:'Gutter Guard Standard Mesh', sub:'guards', cat:'gutters', unit:'LF', mat:5.85, lab:2.85,
      tier:'better', reason:'Gutter mesh guard prevents leaf buildup.',
      tags:['gutter-guard','mesh','standard'] });
  A({ code:'GTR GG-MIC', name:'Gutter Guard Micro-Mesh Stainless', sub:'guards', cat:'gutters', unit:'LF', mat:8.50, lab:3.25,
      tier:'best', reason:'Stainless micro-mesh blocks fine debris and shingle grit.',
      tags:['gutter-guard','micro-mesh','stainless','premium'] });
  A({ code:'GTR GG-REV', name:'Gutter Guard Reverse-Curve', sub:'guards', cat:'gutters', unit:'LF', mat:12.50, lab:4.25,
      tier:'best', reason:'Reverse-curve surface-tension guard.',
      tags:['gutter-guard','reverse-curve','premium'] });
  A({ code:'GTR HNG-H', name:'Gutter Hidden Hangers', sub:'accessories', cat:'gutters', unit:'EA', mat:1.85, lab:0.85,
      tier:'any', reason:'Hidden hangers every 24" per gutter manufacturer spec.',
      tags:['gutter','hanger','hidden'] });
  A({ code:'GTR EC', name:'Gutter End Cap', sub:'accessories', cat:'gutters', unit:'EA', mat:2.85, lab:1.25,
      tier:'any', reason:'End cap required at gutter terminations.',
      tags:['gutter','end-cap','accessories'] });
  A({ code:'GTR MITR', name:'Gutter Miter Corner (Inside/Outside)', sub:'accessories', cat:'gutters', unit:'EA', mat:8.85, lab:3.25,
      tier:'any', reason:'Custom miter corner at gutter direction change.',
      tags:['gutter','miter','corner'] });
  A({ code:'GTR SPLASH', name:'Splash Block (Concrete)', sub:'drainage', cat:'gutters', unit:'EA', mat:8.50, lab:2.85,
      tier:'any', reason:'Concrete splash block at downspout discharge to prevent erosion.',
      tags:['drainage','splash-block','concrete'] });
  A({ code:'GTR UND-DR', name:'Underground Drain Extension (4" PVC, per LF)', sub:'drainage', cat:'gutters', unit:'LF', mat:3.85, lab:6.85,
      tier:'best', reason:'Underground drain extension directs water away from foundation.',
      tags:['drainage','underground','pvc','foundation'] });

  // ═════════════════════════════════════════════════════════
  // 10. FASCIA & SOFFIT (18)
  // ═════════════════════════════════════════════════════════

  A({ code:'FSC AL-06', name:'Fascia Wrap Aluminum 6"', sub:'fascia', cat:'exterior', unit:'LF', mat:2.85, lab:3.25,
      tier:'good', reason:'Aluminum fascia wrap over existing wood fascia.',
      tags:['fascia','aluminum','wrap','6-inch'] });
  A({ code:'FSC AL-08', name:'Fascia Wrap Aluminum 8"', sub:'fascia', cat:'exterior', unit:'LF', mat:3.25, lab:3.25,
      tier:'better', reason:'8" aluminum fascia wrap for larger fascia board.',
      tags:['fascia','aluminum','wrap','8-inch'] });
  A({ code:'FSC AL-10', name:'Fascia Wrap Aluminum 10"', sub:'fascia', cat:'exterior', unit:'LF', mat:3.85, lab:3.65,
      tier:'better', reason:'10" aluminum fascia wrap for commercial/modern applications.',
      tags:['fascia','aluminum','wrap','10-inch'] });
  A({ code:'FSC AL-12', name:'Fascia Wrap Aluminum 12"', sub:'fascia', cat:'exterior', unit:'LF', mat:4.85, lab:3.85,
      tier:'best', reason:'12" wide aluminum fascia wrap.',
      tags:['fascia','aluminum','wrap','12-inch'] });
  A({ code:'FSC WD-06', name:'Fascia Board 1x6 Pine Primed', sub:'fascia', cat:'exterior', unit:'LF', mat:2.25, lab:3.85,
      tier:'good', reason:'Wood fascia board replacement, primed pine.',
      tags:['fascia','wood','1x6','pine'] });
  A({ code:'FSC WD-08', name:'Fascia Board 1x8 Pine Primed', sub:'fascia', cat:'exterior', unit:'LF', mat:2.85, lab:3.85,
      tier:'good', reason:'1x8 wood fascia board.',
      tags:['fascia','wood','1x8','pine'] });
  A({ code:'FSC PVC-06', name:'Fascia Board 1x6 PVC Trim', sub:'fascia', cat:'exterior', unit:'LF', mat:5.85, lab:3.85,
      tier:'best', reason:'PVC trim fascia, rot-proof replacement.',
      tags:['fascia','pvc','trim','rot-proof'] });
  A({ code:'SFT AL-VC', name:'Soffit Aluminum Vented Continuous', sub:'soffit', cat:'exterior', unit:'LF', mat:3.85, lab:2.85,
      desc:'Continuous vented aluminum soffit, baked enamel finish.', tier:'better',
      oh:'OBC R806', ky:'KRC R806', irc:'IRC R806',
      reason:'Vented aluminum soffit provides intake ventilation per OBC R806.',
      tags:['soffit','aluminum','vented','continuous'] });
  A({ code:'SFT AL-SC', name:'Soffit Aluminum Solid', sub:'soffit', cat:'exterior', unit:'LF', mat:3.25, lab:2.85,
      tier:'good', reason:'Solid aluminum soffit (non-vented areas).',
      tags:['soffit','aluminum','solid'] });
  A({ code:'SFT VNL-V', name:'Soffit Vinyl Vented', sub:'soffit', cat:'exterior', unit:'LF', mat:2.85, lab:2.65,
      tier:'good', oh:'OBC R806', ky:'KRC R806', irc:'IRC R806',
      reason:'Vinyl vented soffit, budget ventilation option.',
      tags:['soffit','vinyl','vented'] });
  A({ code:'SFT VNL-S', name:'Soffit Vinyl Solid', sub:'soffit', cat:'exterior', unit:'LF', mat:2.25, lab:2.65,
      tier:'good', reason:'Vinyl solid soffit panel.',
      tags:['soffit','vinyl','solid'] });
  A({ code:'SFT F-CH', name:'F-Channel (Soffit Starter)', sub:'soffit', cat:'exterior', unit:'LF', mat:1.85, lab:1.25,
      tier:'any', reason:'F-channel trim required for soffit installation.',
      tags:['soffit','f-channel','trim'] });
  A({ code:'SFT J-CH', name:'J-Channel (Soffit/Siding Trim)', sub:'soffit', cat:'exterior', unit:'LF', mat:1.65, lab:1.15,
      tier:'any', reason:'J-channel trim for soffit and siding transitions.',
      tags:['soffit','j-channel','trim'] });
  A({ code:'SFT FRZB', name:'Frieze Board 1x6 Wood', sub:'soffit', cat:'exterior', unit:'LF', mat:2.85, lab:3.25,
      tier:'better', reason:'Frieze board transition between siding and soffit.',
      tags:['soffit','frieze','wood','trim'] });
  A({ code:'SFT DC', name:'Drip Cap Aluminum', sub:'trim', cat:'exterior', unit:'LF', mat:1.25, lab:0.85,
      tier:'any', reason:'Drip cap at window/door head flashing.',
      tags:['drip-cap','aluminum','trim'] });
  A({ code:'SFT TG', name:'Wood T&G Bead Board Soffit', sub:'soffit', cat:'exterior', unit:'SF', mat:3.85, lab:3.65,
      tier:'best', reason:'Tongue & groove wood bead board for traditional/porch soffit.',
      tags:['soffit','wood','tongue-groove','bead-board','traditional'] });
  A({ code:'SFT RF', name:'Rake Fascia Replacement', sub:'fascia', cat:'exterior', unit:'LF', mat:3.85, lab:5.25,
      tier:'any', reason:'Rake fascia on gable-end replacement.',
      tags:['fascia','rake','gable'] });
  A({ code:'SFT DMG-R', name:'Rot Repair Fascia/Soffit (HR)', sub:'repair', cat:'exterior', unit:'HR', mat:15, lab:65,
      desc:'Labor charge for deteriorated fascia/soffit demo and prep.', tier:'any',
      reason:'Rot repair labor for deteriorated fascia or soffit requiring selective demolition.',
      tags:['repair','rot','fascia','soffit','labor'], requiresPhoto:true });

  // ═════════════════════════════════════════════════════════
  // 11. LABOR ACTIONS (35)
  // ═════════════════════════════════════════════════════════

  A({ code:'LAB TO1', name:'Tear Off 1 Layer Comp Shingles', sub:'labor-teardown', cat:'labor', unit:'SQ', mat:0, lab:65,
      tier:'any', reason:'Complete removal of existing comp shingle roof, 1 layer.',
      tags:['labor','tear-off','1-layer','shingles'], insuranceDefault:true });
  A({ code:'LAB TO2', name:'Tear Off 2 Layer Comp Shingles', sub:'labor-teardown', cat:'labor', unit:'SQ', mat:0, lab:115,
      tier:'any', reason:'Removal of 2 layers of comp shingles (legacy roof system).',
      tags:['labor','tear-off','2-layer','shingles'], requiresPhoto:true });
  A({ code:'LAB TO3', name:'Tear Off 3 Layer Comp Shingles', sub:'labor-teardown', cat:'labor', unit:'SQ', mat:0, lab:165,
      tier:'any', reason:'Removal of 3 layers of comp shingles. Code typically limits to 2 layers per OBC R908.',
      tags:['labor','tear-off','3-layer','shingles'], requiresPhoto:true });
  A({ code:'LAB TO-TL', name:'Tear Off Tile Roof', sub:'labor-teardown', cat:'labor', unit:'SQ', mat:0, lab:185,
      tier:'any', reason:'Heavy tile removal with structural demo considerations.',
      tags:['labor','tear-off','tile'] });
  A({ code:'LAB TO-MT', name:'Tear Off Metal Roof', sub:'labor-teardown', cat:'labor', unit:'SQ', mat:0, lab:125,
      tier:'any', reason:'Metal panel removal with screw extraction.',
      tags:['labor','tear-off','metal'] });
  A({ code:'LAB TO-WD', name:'Tear Off Wood Shake', sub:'labor-teardown', cat:'labor', unit:'SQ', mat:0, lab:145,
      tier:'any', reason:'Wood shake removal with hand-nail extraction.',
      tags:['labor','tear-off','wood-shake'] });
  A({ code:'LAB TO-SL', name:'Tear Off Slate Roof', sub:'labor-teardown', cat:'labor', unit:'SQ', mat:0, lab:285,
      tier:'any', reason:'Slate removal, specialty labor required.',
      tags:['labor','tear-off','slate','specialty'] });
  A({ code:'LAB INST-SH', name:'Install Shingles (Labor Only)', sub:'labor-install', cat:'labor', unit:'SQ', mat:0, lab:65,
      tier:'any', reason:'Shingle installation labor, for scenarios where material is provided separately.',
      tags:['labor','install','shingles','labor-only'] });
  A({ code:'LAB INST-MT', name:'Install Metal Roofing (Labor Only)', sub:'labor-install', cat:'labor', unit:'SQ', mat:0, lab:225,
      tier:'any', reason:'Metal panel installation labor.',
      tags:['labor','install','metal','labor-only'] });
  A({ code:'LAB INST-MB', name:'Install Modified Bitumen (Labor Only)', sub:'labor-install', cat:'labor', unit:'SQ', mat:0, lab:185,
      tier:'any', reason:'Modified bitumen torch-applied installation.',
      tags:['labor','install','modified-bitumen','labor-only'] });
  A({ code:'LAB INST-IWS', name:'Install Ice & Water Shield (Labor Only)', sub:'labor-install', cat:'labor', unit:'SQ', mat:0, lab:22,
      tier:'any', reason:'Ice & water shield installation labor.',
      tags:['labor','install','ice-water','labor-only'] });
  A({ code:'LAB INST-FL', name:'Install Flashing Labor (per LF)', sub:'labor-install', cat:'labor', unit:'LF', mat:0, lab:4.65,
      tier:'any', reason:'Flashing installation labor for custom scenarios.',
      tags:['labor','install','flashing','labor-only'] });
  A({ code:'LAB INST-RC', name:'Install Ridge/Hip Cap (Labor Only)', sub:'labor-install', cat:'labor', unit:'LF', mat:0, lab:1.85,
      tier:'any', reason:'Ridge and hip cap installation labor.',
      tags:['labor','install','ridge','hip-cap'] });
  A({ code:'LAB INST-DE', name:'Install Drip Edge (Labor Only)', sub:'labor-install', cat:'labor', unit:'LF', mat:0, lab:0.65,
      tier:'any', reason:'Drip edge installation labor.',
      tags:['labor','install','drip-edge','labor-only'] });
  A({ code:'LAB DTL-HR', name:'Detail Work (Per Hour)', sub:'labor-detail', cat:'labor', unit:'HR', mat:0, lab:85,
      desc:'Custom cut work, flashing detailing, hand-cut ridge.', tier:'any',
      reason:'Detail labor for custom finishing work.',
      tags:['labor','detail','hourly','custom'] });
  A({ code:'LAB MOB', name:'Mobilization / Setup', sub:'labor-overhead', cat:'labor', unit:'JOB', mat:0, lab:250,
      tier:'any', reason:'Crew mobilization, equipment setup, tarp protection.',
      tags:['labor','mobilization','setup','overhead'], insuranceDefault:true });
  A({ code:'LAB DEMOB', name:'Demobilization / Final Cleanup', sub:'labor-overhead', cat:'labor', unit:'JOB', mat:0, lab:185,
      tier:'any', reason:'Demobilization, magnetic sweep, debris haul to dumpster.',
      tags:['labor','demobilization','cleanup','overhead'], insuranceDefault:true });
  A({ code:'LAB JSP', name:'Jobsite Protection (Tarps/Ground Cover)', sub:'labor-overhead', cat:'labor', unit:'JOB', mat:25, lab:125,
      tier:'any', reason:'Ground cover tarps and jobsite protection setup.',
      tags:['labor','jobsite','protection','tarps'] });
  A({ code:'LAB CHM-D', name:'Chimney Flash Detail Labor', sub:'labor-detail', cat:'labor', unit:'EA', mat:0, lab:185,
      tier:'any', reason:'Chimney flashing detail work — step, counter, saddle.',
      tags:['labor','chimney','flashing','detail'] });
  A({ code:'LAB SKY-D', name:'Skylight Flash Detail Labor', sub:'labor-detail', cat:'labor', unit:'EA', mat:0, lab:185,
      tier:'any', reason:'Skylight flashing detail installation.',
      tags:['labor','skylight','flashing','detail'] });
  A({ code:'LAB VLY-D', name:'Valley Detail Labor', sub:'labor-detail', cat:'labor', unit:'LF', mat:0, lab:3.85,
      tier:'any', reason:'Valley metal and underlayment detail labor.',
      tags:['labor','valley','detail'] });
  A({ code:'LAB BND-M', name:'Custom Metal Bending On-Site', sub:'labor-detail', cat:'labor', unit:'HR', mat:5, lab:95,
      tier:'best', reason:'On-site metal brake bending for custom flashing.',
      tags:['labor','custom','metal','bending'] });
  A({ code:'LAB CARP', name:'Carpentry Repair Labor (HR)', sub:'labor-carpentry', cat:'labor', unit:'HR', mat:8, lab:65,
      tier:'any', reason:'General carpentry repair labor for decking, fascia, trim.',
      tags:['labor','carpentry','repair'] });
  A({ code:'LAB STR', name:'Structural Repair Labor (HR)', sub:'labor-carpentry', cat:'labor', unit:'HR', mat:15, lab:95,
      tier:'any', oh:'OBC R802', ky:'KRC R802', irc:'IRC R802',
      reason:'Structural framing repair labor per OBC R802 (rafter/truss work).',
      tags:['labor','structural','framing'], requiresPhoto:true });
  A({ code:'LAB ADR-2S', name:'Two-Story Labor Adder (%)', sub:'labor-adder', cat:'labor', unit:'SQ', mat:0, lab:12,
      desc:'Labor adder for 2-story installations.', tier:'any',
      reason:'Two-story installation labor adder for equipment handling and fall protection.',
      tags:['labor','adder','two-story'] });
  A({ code:'LAB ADR-SS', name:'Steep Slope Labor Adder 8/12+', sub:'labor-adder', cat:'labor', unit:'SQ', mat:0, lab:25,
      tier:'any', oh:'OBC R905', ky:'KRC R905',
      reason:'Steep slope labor adder (8/12 pitch or greater) for safety harness and reduced crew productivity.',
      tags:['labor','adder','steep-slope','safety'] });
  A({ code:'LAB ADR-VS', name:'Very Steep Slope Labor Adder 12/12+', sub:'labor-adder', cat:'labor', unit:'SQ', mat:0, lab:45,
      tier:'any', reason:'Very steep slope labor adder (12/12+) for roof jacks and safety systems.',
      tags:['labor','adder','very-steep','safety'] });
  A({ code:'LAB ADR-CU', name:'Cut-Up Roof Labor Adder', sub:'labor-adder', cat:'labor', unit:'SQ', mat:0, lab:15,
      tier:'any', reason:'Cut-up roof labor adder for complex geometry (many valleys/hips/dormers).',
      tags:['labor','adder','cut-up','complex'] });
  A({ code:'LAB ADR-WK', name:'Weekend / Emergency Labor Adder', sub:'labor-adder', cat:'labor', unit:'SQ', mat:0, lab:25,
      tier:'any', reason:'Weekend/emergency response labor adder.',
      tags:['labor','adder','weekend','emergency'] });
  A({ code:'LAB ADR-OT', name:'Overtime Labor Adder', sub:'labor-adder', cat:'labor', unit:'HR', mat:0, lab:50,
      tier:'any', reason:'Overtime labor rate adder (50% over base).',
      tags:['labor','adder','overtime'] });
  A({ code:'LAB WATR-D', name:'Water Damage Dry-In / Emergency Tarp', sub:'labor-emergency', cat:'labor', unit:'JOB', mat:85, lab:350,
      tier:'any', reason:'Emergency tarp and dry-in for water-damaged roof.',
      tags:['labor','emergency','tarp','dry-in'] });
  A({ code:'LAB CLN-M', name:'Magnetic Nail Sweep', sub:'labor-cleanup', cat:'labor', unit:'JOB', mat:0, lab:125,
      tier:'any', reason:'Magnetic nail sweep of yard and driveway post-install.',
      tags:['labor','cleanup','magnetic-sweep'], insuranceDefault:true });
  A({ code:'LAB PHOTO', name:'Photo Documentation (Insurance)', sub:'labor-documentation', cat:'labor', unit:'JOB', mat:0, lab:125,
      desc:'Complete photo documentation for insurance claim.', tier:'any',
      reason:'Photo documentation for insurance scope validation and pre/post-damage records.',
      tags:['labor','documentation','insurance','photos'], insuranceDefault:true });
  A({ code:'LAB WALK', name:'Final Walk-Through & QC', sub:'labor-qc', cat:'labor', unit:'JOB', mat:0, lab:125,
      tier:'any', reason:'Post-installation quality control walk-through.',
      tags:['labor','walk-through','quality-control'] });
  A({ code:'LAB SUP', name:'Site Supervision (Per Day)', sub:'labor-supervision', cat:'labor', unit:'DAY', mat:0, lab:285,
      tier:'any', reason:'On-site supervisor per day for complex or commercial jobs.',
      tags:['labor','supervision','foreman'] });

  // ═════════════════════════════════════════════════════════
  // 12. DISPOSAL / DUMPSTERS (8)
  // ═════════════════════════════════════════════════════════

  A({ code:'DSP 10YD', name:'Dumpster 10-Yard', sub:'disposal', cat:'disposal', unit:'JOB', mat:325, lab:0,
      tier:'any', reason:'10-yard dumpster for small jobs (up to ~15 SQ tear-off).',
      tags:['disposal','dumpster','10yd'] });
  A({ code:'DSP 20YD', name:'Dumpster 20-Yard', sub:'disposal', cat:'disposal', unit:'JOB', mat:425, lab:0,
      tier:'any', reason:'20-yard dumpster for mid-size jobs (~25 SQ tear-off).',
      tags:['disposal','dumpster','20yd'] });
  A({ code:'DSP 30YD', name:'Dumpster 30-Yard', sub:'disposal', cat:'disposal', unit:'JOB', mat:550, lab:0,
      tier:'any', reason:'30-yard dumpster standard for residential reroof (~35 SQ).',
      tags:['disposal','dumpster','30yd'], insuranceDefault:true });
  A({ code:'DSP 40YD', name:'Dumpster 40-Yard', sub:'disposal', cat:'disposal', unit:'JOB', mat:750, lab:0,
      tier:'any', reason:'40-yard dumpster for large residential or commercial.',
      tags:['disposal','dumpster','40yd'] });
  A({ code:'DSP HAUL', name:'Haul-Away Load (Truck)', sub:'disposal', cat:'disposal', unit:'EA', mat:185, lab:0,
      tier:'any', reason:'Truck haul-away load for small volume disposal.',
      tags:['disposal','haul-away','truck'] });
  A({ code:'DSP DBR-H', name:'Hand Debris Removal (HR)', sub:'disposal', cat:'disposal', unit:'HR', mat:0, lab:65,
      tier:'any', reason:'Hand removal of debris where dumpster access is limited.',
      tags:['disposal','debris','manual'] });
  A({ code:'DSP TARP', name:'Dumpster Tarp Containment', sub:'disposal', cat:'disposal', unit:'JOB', mat:45, lab:0,
      tier:'any', reason:'Tarp containment at dumpster for debris control.',
      tags:['disposal','tarp','containment'] });
  A({ code:'DSP OVER', name:'Dumpster Overage / Extra Weight', sub:'disposal', cat:'disposal', unit:'JOB', mat:225, lab:0,
      tier:'any', reason:'Overage charge for dumpster weight beyond included limit.',
      tags:['disposal','overage','weight'] });

  // ═════════════════════════════════════════════════════════
  // 12b. MATERIAL DELIVERY (1)
  //
  // Materials coming IN. Everything above in section 12 is waste going OUT
  // (dumpsters, haul-away), and LAB MOB is the CREW arriving — so before this
  // line there was no place at all to recover what the supplier charges to put
  // materials on the roof. Suppliers bill it per trip plus a fuel surcharge,
  // and a reroof routinely takes deliveries from two of them.
  //
  // It exists because the material unit costs in this file are quoted EX-TAX
  // and EX-DELIVERY: tax rides the estimate's own tax line and delivery rides
  // here. Fold it back into the per-unit costs and it double-counts.
  //
  // BASELINE FIGURE, like every other cost in this file — a plausible regional
  // two-supplier trip, not any company's negotiated rate. A tenant's real
  // delivery cost belongs in catalogCosts/{companyId}.xactCosts, where
  // NBD_XACT_CATALOG.find() overlays it. See
  // documentation/audit/CATALOG-UNDER-COST-2026-08-19.md.
  // ═════════════════════════════════════════════════════════

  // fixedRetail (Jo, 2026-09-27): the CUSTOMER price per JOB, O&P included —
  // $150, the same as the per-SQ delivery add-on. A RETAIL figure, not a cost:
  // the engine (estimate-logic-engine.js resolveEstimate) prices the line at
  // it and backs the estimate's O&P out of the row, so the row plus its O&P
  // share foot to exactly $150. The modelled COST (mat, or a tenant's cost
  // book) is untouched, so the margin report still books the real trip.
  A({ code:'MAT DEL', name:'Material Delivery & Fuel Surcharge', sub:'delivery', cat:'materials', unit:'JOB', mat:275, lab:0, fixedRetail:150,
      desc:'Supplier delivery to site plus fuel surcharge. Typical reroof draws from two suppliers (shingles/accessories and metal/vents), each billing a per-trip charge.',
      tier:'any', reason:'Supplier delivery and fuel surcharge to place materials at the job site.',
      tags:['delivery','freight','fuel','materials','logistics'] });

  // ═════════════════════════════════════════════════════════
  // 13. PERMITS & INSPECTION (8)
  // ═════════════════════════════════════════════════════════

  A({ code:'PRM RES-OH', name:'Residential Permit — OH County', sub:'permits', cat:'permits', unit:'JOB', mat:165, lab:45,
      desc:'Average residential roofing permit for Hamilton/Butler/Warren/Clermont OH.', tier:'any',
      oh:'OBC R105', reason:'Building permit required per OBC R105 for roof replacement.',
      tags:['permits','ohio','residential'], insuranceDefault:true });
  A({ code:'PRM RES-KY', name:'Residential Permit — KY County', sub:'permits', cat:'permits', unit:'JOB', mat:125, lab:45,
      desc:'Average residential roofing permit for Kenton/Boone/Campbell KY.', tier:'any',
      ky:'KRC R105', reason:'Building permit required per KRC R105 for roof replacement.',
      tags:['permits','kentucky','residential'], insuranceDefault:true });
  A({ code:'PRM COM', name:'Commercial Roofing Permit', sub:'permits', cat:'permits', unit:'JOB', mat:385, lab:85,
      tier:'any', oh:'OBC R105', ky:'KRC R105',
      reason:'Commercial building permit required for commercial roofing.',
      tags:['permits','commercial'] });
  A({ code:'PRM HIS', name:'Historic District Permit Surcharge', sub:'permits', cat:'permits', unit:'JOB', mat:225, lab:85,
      tier:'any', reason:'Historic district review surcharge for approved material matching.',
      tags:['permits','historic','surcharge'] });
  A({ code:'PRM HOA', name:'HOA Architectural Review Fee', sub:'permits', cat:'permits', unit:'JOB', mat:125, lab:45,
      tier:'any', reason:'HOA architectural review fee and documentation submission.',
      tags:['permits','hoa','review'] });
  A({ code:'PRM INS', name:'Building Inspection Fee', sub:'permits', cat:'permits', unit:'JOB', mat:85, lab:0,
      tier:'any', oh:'OBC R109', ky:'KRC R109',
      reason:'Final inspection fee per OBC R109 for residential roofing.',
      tags:['permits','inspection'] });
  A({ code:'PRM REINS', name:'Re-Inspection Fee', sub:'permits', cat:'permits', unit:'JOB', mat:125, lab:0,
      tier:'any', reason:'Re-inspection fee if initial inspection fails.',
      tags:['permits','re-inspection'] });
  A({ code:'PRM ENG', name:'Engineering Letter (Structural)', sub:'permits', cat:'permits', unit:'JOB', mat:650, lab:0,
      desc:'Engineering letter for structural framing verification.', tier:'any',
      oh:'OBC R802', ky:'KRC R802',
      reason:'Structural engineering letter required for non-standard framing repairs or additions per OBC R802.',
      tags:['permits','engineering','structural'] });

  // ═════════════════════════════════════════════════════════
  // 14. INTERIOR DAMAGE (light support, 10)
  // ═════════════════════════════════════════════════════════

  A({ code:'INT DW-S', name:'Drywall Patch Small (<2 SF)', sub:'interior-drywall', cat:'interior', unit:'EA', mat:15, lab:85,
      tier:'any', reason:'Drywall patch for small water-damaged area under 2 SF.',
      tags:['interior','drywall','patch','water-damage'] });
  A({ code:'INT DW-M', name:'Drywall Patch Medium (2-8 SF)', sub:'interior-drywall', cat:'interior', unit:'EA', mat:35, lab:165,
      tier:'any', reason:'Medium drywall patch with texture match.',
      tags:['interior','drywall','patch','medium'] });
  A({ code:'INT DW-L', name:'Drywall Patch Large (8+ SF)', sub:'interior-drywall', cat:'interior', unit:'SF', mat:4.25, lab:12.50,
      tier:'any', reason:'Large drywall replacement with framing if needed.',
      tags:['interior','drywall','patch','large'] });
  A({ code:'INT CLG-P', name:'Ceiling Patch & Texture Match', sub:'interior-ceiling', cat:'interior', unit:'EA', mat:45, lab:195,
      tier:'any', reason:'Ceiling patch with texture match (orange peel / knockdown).',
      tags:['interior','ceiling','patch','texture'] });
  A({ code:'INT PNT-T', name:'Paint Touch-Up (per spot)', sub:'interior-paint', cat:'interior', unit:'EA', mat:8, lab:45,
      tier:'any', reason:'Paint touch-up for repaired area.',
      tags:['interior','paint','touch-up'] });
  A({ code:'INT PNT-C1', name:'Paint Ceiling 1 Coat', sub:'interior-paint', cat:'interior', unit:'SF', mat:0.35, lab:1.25,
      tier:'any', reason:'Ceiling paint single coat over prepped surface.',
      tags:['interior','paint','ceiling','1-coat'] });
  A({ code:'INT PNT-C2', name:'Paint Ceiling 2 Coat', sub:'interior-paint', cat:'interior', unit:'SF', mat:0.55, lab:2.15,
      tier:'any', reason:'Ceiling paint 2-coat system for full coverage.',
      tags:['interior','paint','ceiling','2-coat'] });
  A({ code:'INT PNT-R', name:'Paint Room (Walls + Ceiling)', sub:'interior-paint', cat:'interior', unit:'RM', mat:125, lab:425,
      tier:'any', reason:'Complete room repaint (walls + ceiling) after drywall repair.',
      tags:['interior','paint','room'] });
  A({ code:'INT TEX', name:'Texture Match (Orange Peel / Knockdown)', sub:'interior-texture', cat:'interior', unit:'SF', mat:0.85, lab:1.85,
      tier:'any', reason:'Texture match for patched drywall areas.',
      tags:['interior','texture','match'] });
  A({ code:'INT FLR-R', name:'Flooring Repair Spot (HR)', sub:'interior-flooring', cat:'interior', unit:'HR', mat:15, lab:65,
      tier:'any', reason:'Spot flooring repair for water-damaged section.',
      tags:['interior','flooring','repair'] });

  // ═════════════════════════════════════════════════════════
  // 15. TREE / LANDSCAPE PROTECTION (8)
  // ═════════════════════════════════════════════════════════

  A({ code:'LND TRP-G', name:'Ground Cover Tarps', sub:'landscape-protection', cat:'protection', unit:'JOB', mat:45, lab:65,
      tier:'any', reason:'Ground cover tarps to protect landscaping during tear-off.',
      tags:['protection','tarps','ground','landscape'] });
  A({ code:'LND TRP-S', name:'Shrub Protection Tarps', sub:'landscape-protection', cat:'protection', unit:'EA', mat:25, lab:45,
      tier:'any', reason:'Shrub protection during roof tear-off and debris handling.',
      tags:['protection','shrubs','tarps'] });
  A({ code:'LND AC-C', name:'AC Unit Cover', sub:'landscape-protection', cat:'protection', unit:'EA', mat:15, lab:25,
      tier:'any', reason:'AC unit cover to prevent debris contamination.',
      tags:['protection','ac','unit'] });
  A({ code:'LND FNC-P', name:'Fence Protection', sub:'landscape-protection', cat:'protection', unit:'LF', mat:0.85, lab:1.25,
      tier:'any', reason:'Fence protection during equipment staging.',
      tags:['protection','fence'] });
  A({ code:'LND DRV-P', name:'Driveway Protection Plywood', sub:'landscape-protection', cat:'protection', unit:'SF', mat:0.65, lab:0.85,
      tier:'any', reason:'Plywood protection over driveway for dumpster and equipment.',
      tags:['protection','driveway','plywood'] });
  A({ code:'LND GDN-P', name:'Garden/Flower Bed Protection', sub:'landscape-protection', cat:'protection', unit:'SF', mat:0.45, lab:0.65,
      tier:'any', reason:'Flower bed tarp and barricade protection.',
      tags:['protection','garden','flowers'] });
  A({ code:'LND POOL', name:'Pool Cover / Protection', sub:'landscape-protection', cat:'protection', unit:'JOB', mat:85, lab:125,
      tier:'any', reason:'Pool cover and debris barrier for pool-adjacent jobs.',
      tags:['protection','pool','cover'] });
  A({ code:'LND DCK', name:'Deck Cover (Full Job)', sub:'landscape-protection', cat:'protection', unit:'JOB', mat:65, lab:85,
      tier:'any', reason:'Deck surface protection during debris handling.',
      tags:['protection','deck','cover'] });

  // ═════════════════════════════════════════════════════════
  // 16. EMERGENCY SERVICES (8)
  // ═════════════════════════════════════════════════════════

  A({ code:'EMR TRP', name:'Emergency Tarp Installation', sub:'emergency', cat:'emergency', unit:'SQ', mat:35, lab:125,
      desc:'Emergency tarp for storm-damaged roof.', tier:'any',
      reason:'Emergency tarp required to prevent secondary water damage. Insurance may cover as mitigation.',
      tags:['emergency','tarp','storm','mitigation'], insuranceDefault:true });
  A({ code:'EMR TREE', name:'Tree Removal From Roof', sub:'emergency', cat:'emergency', unit:'JOB', mat:0, lab:850,
      tier:'any', reason:'Tree removal from roof (chainsaw + rigging work).',
      tags:['emergency','tree','removal','chainsaw'] });
  A({ code:'EMR BRD', name:'Board-Up Service', sub:'emergency', cat:'emergency', unit:'JOB', mat:125, lab:225,
      tier:'any', reason:'Structural board-up for damaged openings.',
      tags:['emergency','board-up','security'] });
  A({ code:'EMR WTR', name:'Water Extraction', sub:'emergency', cat:'emergency', unit:'RM', mat:0, lab:225,
      tier:'any', reason:'Water extraction from interior after roof leak.',
      tags:['emergency','water','extraction','mitigation'] });
  A({ code:'EMR STR', name:'Structural Bracing Emergency', sub:'emergency', cat:'emergency', unit:'JOB', mat:225, lab:485,
      tier:'any', oh:'OBC R802', ky:'KRC R802',
      reason:'Emergency structural bracing for damaged rafters per OBC R802.',
      tags:['emergency','structural','bracing'] });
  A({ code:'EMR DBR', name:'Emergency Debris Removal', sub:'emergency', cat:'emergency', unit:'JOB', mat:85, lab:325,
      tier:'any', reason:'Emergency debris removal from roof and yard.',
      tags:['emergency','debris','removal'] });
  A({ code:'EMR INS', name:'Initial Damage Inspection', sub:'emergency', cat:'emergency', unit:'JOB', mat:0, lab:150,
      tier:'any', reason:'Initial damage inspection and documentation.',
      tags:['emergency','inspection','documentation'] });
  A({ code:'EMR MOB', name:'Emergency Mobilization Adder', sub:'emergency', cat:'emergency', unit:'JOB', mat:0, lab:250,
      tier:'any', reason:'Emergency response mobilization charge.',
      tags:['emergency','mobilization','after-hours'] });

  // ═════════════════════════════════════════════════════════
  // 17. EQUIPMENT / STAGING (10)
  // ═════════════════════════════════════════════════════════

  A({ code:'EQP BOOM-D', name:'Boom Lift Rental Per Day', sub:'equipment', cat:'equipment', unit:'DAY', mat:385, lab:0,
      tier:'any', reason:'Boom lift rental for hard-to-reach areas or 2nd/3rd story access.',
      tags:['equipment','boom-lift','rental'] });
  A({ code:'EQP SCISS-D', name:'Scissor Lift Rental Per Day', sub:'equipment', cat:'equipment', unit:'DAY', mat:285, lab:0,
      tier:'any', reason:'Scissor lift rental for low-slope commercial work.',
      tags:['equipment','scissor-lift','rental'] });
  A({ code:'EQP SCAF', name:'Scaffolding Setup (Per Section)', sub:'equipment', cat:'equipment', unit:'EA', mat:125, lab:125,
      tier:'any', reason:'Scaffolding setup for chimney, dormer, or vertical access.',
      tags:['equipment','scaffolding','setup'] });
  A({ code:'EQP LDR-32', name:'Ladder 32ft', sub:'equipment', cat:'equipment', unit:'DAY', mat:25, lab:0,
      tier:'any', reason:'32ft extension ladder.',
      tags:['equipment','ladder','32ft'] });
  A({ code:'EQP LDR-40', name:'Ladder 40ft', sub:'equipment', cat:'equipment', unit:'DAY', mat:35, lab:0,
      tier:'any', reason:'40ft extension ladder for tall roofs.',
      tags:['equipment','ladder','40ft'] });
  A({ code:'EQP RJ', name:'Roof Jacks (Set of 8)', sub:'equipment', cat:'equipment', unit:'EA', mat:85, lab:45,
      tier:'any', oh:'OSHA 1926', reason:'Roof jacks required for steep slopes per OSHA 1926 fall protection.',
      tags:['equipment','roof-jacks','safety','steep-slope'] });
  A({ code:'EQP HRN', name:'Safety Harness System', sub:'equipment', cat:'equipment', unit:'JOB', mat:45, lab:65,
      tier:'any', oh:'OSHA 1926', reason:'Safety harness and anchor system per OSHA 1926 fall protection for steep slopes.',
      tags:['equipment','harness','safety','osha'] });
  A({ code:'EQP GEN', name:'Generator Rental Per Day', sub:'equipment', cat:'equipment', unit:'DAY', mat:85, lab:0,
      tier:'any', reason:'Generator rental for sites without power access.',
      tags:['equipment','generator','rental'] });
  A({ code:'EQP AIR', name:'Air Compressor Rental Per Day', sub:'equipment', cat:'equipment', unit:'DAY', mat:65, lab:0,
      tier:'any', reason:'Air compressor for nailer / pneumatic tools.',
      tags:['equipment','compressor','rental'] });
  A({ code:'EQP NAIL-R', name:'Roofing Nailer Rental Per Day', sub:'equipment', cat:'equipment', unit:'DAY', mat:35, lab:0,
      tier:'any', reason:'Roofing coil nailer rental.',
      tags:['equipment','nailer','rental'] });

  // ═════════════════════════════════════════════════════════
  // 18. CODE UPGRADES (OH/KY specific, 8)
  // ═════════════════════════════════════════════════════════

  A({ code:'CUP IWS-E', name:'Ice & Water Shield at Eaves (Code Upgrade)', sub:'code-upgrade', cat:'code-upgrade', unit:'LF', mat:8.50, lab:2.25,
      desc:'Code-required ice & water shield from eave to 24" inside exterior wall.', tier:'any',
      oh:'OBC R905.1.2', ky:'KRC R905.1.2', irc:'IRC R905.1.2',
      reason:'REQUIRED per OBC R905.1.2: Ice barrier extending from eave edge to at least 24" inside the exterior wall line where the average January temperature is 25°F or less. Cincinnati/NKY requires this.',
      tags:['code-upgrade','ice-water','eave','required','obc-r9051'], insuranceDefault:true, requiresPhoto:true });
  A({ code:'CUP DRPE', name:'Drip Edge Upgrade (Code)', sub:'code-upgrade', cat:'code-upgrade', unit:'LF', mat:1.95, lab:0.65,
      tier:'any', oh:'OBC R905.2.8.5', ky:'KRC R905.2.8.5', irc:'IRC R905.2.8.5',
      reason:'Drip edge at eaves and rakes required per OBC R905.2.8.5 (2019 adoption).',
      tags:['code-upgrade','drip-edge','code-required'], insuranceDefault:true });
  A({ code:'CUP VNT-R', name:'Ventilation Ratio 1:150 (Code Upgrade)', sub:'code-upgrade', cat:'code-upgrade', unit:'JOB', mat:185, lab:125,
      tier:'any', oh:'OBC R806', ky:'KRC R806', irc:'IRC R806',
      reason:'Attic ventilation minimum 1:150 NFA ratio per OBC R806, or 1:300 with balanced intake/exhaust.',
      tags:['code-upgrade','ventilation','required','obc-r806'], insuranceDefault:true });
  A({ code:'CUP HC', name:'Hurricane Clip / H2.5 Installation', sub:'code-upgrade', cat:'code-upgrade', unit:'EA', mat:3.85, lab:4.25,
      desc:'H2.5 Simpson Strong-Tie hurricane clip at rafter-to-top-plate connection.', tier:'best',
      oh:'OBC R802.11', ky:'KRC R802.11', irc:'IRC R802.11',
      reason:'Hurricane clip required for high-wind zones per OBC R802.11 rafter-to-top-plate connection.',
      tags:['code-upgrade','hurricane-clip','h2.5','wind-resistant'], insuranceDefault:true });
  A({ code:'CUP DCK-R', name:'Reinforced Decking (Wind Zone)', sub:'code-upgrade', cat:'code-upgrade', unit:'SF', mat:0.35, lab:0.45,
      tier:'best', oh:'OBC R803', ky:'KRC R803', irc:'IRC R803',
      reason:'Enhanced decking fastener schedule for wind zones per OBC R803.2.3.1.',
      tags:['code-upgrade','decking','wind-resistant'] });
  A({ code:'CUP KICK', name:'Kickout Flashing at Roof/Wall Junction (Code)', sub:'code-upgrade', cat:'code-upgrade', unit:'EA', mat:8.50, lab:28,
      tier:'any', oh:'OBC R903.2.1', ky:'KRC R903.2.1', irc:'IRC R903.2.1',
      reason:'REQUIRED per OBC R903.2.1: Kickout flashing at roof-wall intersections where gutter or wall terminates above grade.',
      tags:['code-upgrade','kickout','flashing','required','obc-r9032'], insuranceDefault:true });
  A({ code:'CUP RB', name:'Radiant Barrier Decking (Energy Code)', sub:'code-upgrade', cat:'code-upgrade', unit:'SF', mat:0.45, lab:0.15,
      tier:'best', oh:'OEC R402', reason:'Radiant barrier decking reduces cooling load per OEC R402 energy code.',
      tags:['code-upgrade','radiant-barrier','energy-code'] });
  A({ code:'CUP FNR', name:'Fastener Upgrade (6 per shingle)', sub:'code-upgrade', cat:'code-upgrade', unit:'SQ', mat:2.25, lab:15,
      desc:'Upgrade to 6 nails per shingle for wind zones.', tier:'best',
      oh:'OBC R905.2.5', ky:'KRC R905.2.5', irc:'IRC R905.2.5',
      reason:'6 nails per shingle required for high-wind zones per OBC R905.2.5.',
      tags:['code-upgrade','fasteners','wind-resistant'] });

  // ═════════════════════════════════════════════════════════
  // 19. SPECIALTY / ACCESSORIES (10)
  // ═════════════════════════════════════════════════════════

  A({ code:'SPC CHM-C', name:'Chimney Cap Stainless Steel', sub:'specialty', cat:'specialty', unit:'EA', mat:285, lab:185,
      tier:'best', oh:'OBC R1003.9', reason:'Chimney cap per OBC R1003.9 prevents rain/snow entry.',
      tags:['specialty','chimney','cap','stainless'] });
  A({ code:'SPC CHM-CR', name:'Chimney Crown Repair', sub:'specialty', cat:'specialty', unit:'EA', mat:185, lab:385,
      tier:'any', oh:'OBC R1003.9', ky:'KRC R1003.9',
      reason:'Chimney crown repair per OBC R1003.9.',
      tags:['specialty','chimney','crown','repair'] });
  A({ code:'SPC SNW-G', name:'Snow Guards (Pad-Style, per LF)', sub:'specialty', cat:'specialty', unit:'LF', mat:18, lab:12,
      tier:'better', reason:'Snow guards prevent avalanching on metal roofs.',
      tags:['specialty','snow-guard','metal','safety'] });
  A({ code:'SPC HC', name:'Heat Cable (Ice Dam Prevention)', sub:'specialty', cat:'specialty', unit:'LF', mat:8.50, lab:4.25,
      tier:'better', reason:'Heat cable prevents ice dam formation at eaves.',
      tags:['specialty','heat-cable','ice-dam'] });
  A({ code:'SPC LR', name:'Lightning Rod System', sub:'specialty', cat:'specialty', unit:'EA', mat:385, lab:225,
      tier:'best', reason:'Lightning protection system per NFPA 780.',
      tags:['specialty','lightning','nfpa-780'] });
  A({ code:'SPC CRK', name:'Cricket Saddle (Custom)', sub:'specialty', cat:'specialty', unit:'EA', mat:185, lab:285,
      tier:'any', oh:'OBC R1003.20', ky:'KRC R1003.20',
      reason:'Custom cricket saddle for chimneys >30" wide per OBC R1003.20.',
      tags:['specialty','cricket','saddle','chimney','custom'] });
  A({ code:'SPC DRM', name:'Dormer Detail Work (HR)', sub:'specialty', cat:'specialty', unit:'HR', mat:25, lab:95,
      tier:'any', reason:'Custom dormer detail labor for complex roof features.',
      tags:['specialty','dormer','detail','custom'] });
  A({ code:'SPC CUP-I', name:'Cupola Installation', sub:'specialty', cat:'specialty', unit:'EA', mat:585, lab:425,
      tier:'best', reason:'Decorative cupola installation with ridge venting integration.',
      tags:['specialty','cupola','decorative'] });
  A({ code:'SPC WTV', name:'Weathervane Installation', sub:'specialty', cat:'specialty', unit:'EA', mat:185, lab:125,
      tier:'best', reason:'Decorative weathervane installation on ridge or cupola.',
      tags:['specialty','weathervane','decorative'] });
  A({ code:'SPC FNL', name:'Copper Finial Custom', sub:'specialty', cat:'specialty', unit:'EA', mat:485, lab:185,
      tier:'best', reason:'Copper finial for historic restoration.',
      tags:['specialty','copper','finial','historic'] });

  // ═════════════════════════════════════════════════════════
  // 20. WARRANTY & DOCUMENTATION (3)
  // ═════════════════════════════════════════════════════════

  // NBD registers GAF System Plus (available to GAF Certified contractors).
  // GAF Golden Pledge + Silver Pledge require GAF MASTER ELITE, which Joe does
  // not hold — quoting them promises coverage NBD can't register. Default GAF
  // warranty corrected to System Plus. (Re-add the Master-Elite tiers only if/
  // when Joe earns Master Elite.)  [accuracy fix 2026-06-24]
  A({ code:'WAR SYSP-GAF', name:'GAF System Plus Limited Warranty', sub:'warranty', cat:'warranty', unit:'JOB', mat:285, lab:85,
      desc:'GAF System Plus — material + workmanship system warranty, registerable by GAF Certified contractors (what NBD holds).', tier:'best',
      reason:'GAF System Plus Limited Warranty covers the full system; NBD can register it as a GAF Certified contractor.',
      tags:['warranty','gaf','system-plus','best-tier'], retailDefault:true });
  // OC system warranties (Preferred / Platinum Preferred) require Owens Corning
  // contractor-network status, which Joe holds NONE of — quoting any OC system
  // warranty would promise coverage NBD cannot register. OC shingles still carry
  // their standard manufacturer warranty (included, no cert), filed via the
  // generic "Manufacturer Warranty Registration" line below. The cert-gated OC
  // system-warranty line was removed for this reason. (Re-add only if Joe joins
  // the OC contractor network.)  [accuracy fix 2026-06-24 — confirmed no OC certs]
  A({ code:'WAR MFG', name:'Manufacturer Warranty Registration', sub:'warranty', cat:'warranty', unit:'JOB', mat:0, lab:65,
      tier:'any', reason:'Manufacturer warranty registration filing on customer behalf.',
      tags:['warranty','registration','documentation'], insuranceDefault:true });
  A({ code:'WAR LAB', name:'Labor Warranty Documentation', sub:'warranty', cat:'warranty', unit:'JOB', mat:0, lab:45,
      tier:'any', reason:'NBD labor warranty documentation and certificate.',
      tags:['warranty','labor','nbd','certificate'], retailDefault:true });

  // ═════════════════════════════════════════════════════════
  // Finalize: compute unitCost, group, and register
  // ═════════════════════════════════════════════════════════
  ITEMS.forEach(item => {
    item.materialCost = item.mat;
    item.laborCost = item.lab;
    item.unitCost = (Number(item.mat) || 0) + (Number(item.lab) || 0);
    delete item.mat;
    delete item.lab;
    // Promote code refs into a single object
    item.codeRefs = {};
    if (item.oh)   item.codeRefs.oh   = item.oh;
    if (item.ky)   item.codeRefs.ky   = item.ky;
    if (item.irc)  item.codeRefs.irc  = item.irc;
    if (item.nrca) item.codeRefs.nrca = item.nrca;
    if (item.ul)   item.codeRefs.ul   = item.ul;
    if (item.osha) item.codeRefs.osha = item.osha;
    delete item.oh; delete item.ky; delete item.irc; delete item.nrca; delete item.ul; delete item.osha;
  });

  // Build category index
  const BY_CATEGORY = {};
  const BY_SUB = {};
  ITEMS.forEach(item => {
    BY_CATEGORY[item.category] = BY_CATEGORY[item.category] || [];
    BY_CATEGORY[item.category].push(item);
    if (item.sub) {
      BY_SUB[item.sub] = BY_SUB[item.sub] || [];
      BY_SUB[item.sub].push(item);
    }
  });

  // Build code index for quick lookup
  const BY_CODE = {};
  ITEMS.forEach(item => { BY_CODE[item.code] = item; });

  // ═════════════════════════════════════════════════════════
  // Public API
  // ═════════════════════════════════════════════════════════
  window.NBD_XACT_CATALOG = {
    items: ITEMS,
    byCategory: BY_CATEGORY,
    bySub: BY_SUB,
    byCode: BY_CODE,
    count: ITEMS.length,

    // THE tenant-aware lookup. Every pricing consumer goes through here —
    // estimate-v2-ui (getCurrentEstimate, the tier paths), job-templates
    // (resolveSelection), estimate-finalization, estimate-supplement — so this
    // is the single point where a company's own figures reach the money.
    // Verified: nothing reads BY_CODE directly for pricing.
    //
    // The published mat/lab values are a STARTER BASELINE, not any company's
    // real cost. Unlike the labor catalog's crew productivity, nothing here
    // could simply be deleted: these figures ARE the pricing, there is no
    // public retail half to fall back on, and stripping them would leave a new
    // tenant unable to produce an estimate at all rather than merely unable to
    // see a margin. So the baseline stays published and the tenant's book
    // OVERRIDES it — what makes that safe is the tenant's real figures being
    // different (rotation), not the baseline being hidden. It cannot be hidden:
    // it is readable at every past commit regardless.
    // documentation/projects/PHASE2-PUBLISHED-COST-BASIS-BRIEF-2026-08-18.md
    //
    // Overlay on READ rather than mutating BY_CODE at load, so a cost book that
    // lands late (cold device, Firestore still in flight) is picked up on the
    // next lookup with no re-registration step — and so the published baseline
    // stays intact underneath for a tenant who has no book.
    find: function(code) {
      const base = BY_CODE[code] || null;
      if (!base) return null;
      try {
        const cc = window.NBDCatalogCosts;
        const entry = (cc && typeof cc.xactCost === 'function') ? cc.xactCost(code) : null;
        // Validate HERE as well as in catalog-costs.js. Not belt-and-braces:
        // this is the last point before the number becomes a customer total,
        // and an unchecked Object.assign will happily write NaN over a good
        // baseline — which prices a line at NaN rather than falling back.
        // Caught by a corrupt-book probe while wiring this up.
        if (entry) {
          const mat = Number(entry.materialCost);
          const lab = Number(entry.laborCost);
          if (isFinite(mat) && isFinite(lab) && mat >= 0 && lab >= 0) {
            return Object.assign({}, base, { materialCost: mat, laborCost: lab });
          }
        }
      } catch (e) { /* no book is a normal state, not an error */ }
      return base;
    },

    // Filter by category
    byCat: function(cat) { return BY_CATEGORY[cat] || []; },

    // Filter by tier
    byTier: function(tier) {
      return ITEMS.filter(i => i.tier === tier || i.tier === 'any');
    },

    // Search by keyword (name or tags)
    search: function(q) {
      q = (q || '').toLowerCase();
      if (!q) return ITEMS.slice();
      return ITEMS.filter(i =>
        (i.name || '').toLowerCase().includes(q) ||
        (i.code || '').toLowerCase().includes(q) ||
        (i.tags || []).some(t => t.toLowerCase().includes(q))
      );
    },

    // Get all insurance-default items (auto-add to insurance scope)
    insuranceDefaults: function() {
      return ITEMS.filter(i => i.insuranceDefault);
    },

    // Get all items that require a photo for insurance scope
    requiresPhoto: function() {
      return ITEMS.filter(i => i.requiresPhoto);
    }
  };

  // Bridge into the v2 estimate engine's catalog if available
  if (window.EstimateBuilderV2 && window.EstimateBuilderV2.CATALOG) {
    ITEMS.forEach(item => {
      // Use code as the catalog key
      const key = `xact-${item.code.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-]/g,'')}`;
      window.EstimateBuilderV2.CATALOG[key] = {
        code: item.code,
        name: item.name,
        category: item.sub || item.category,
        unit: item.unit,
        cost: item.materialCost,
        labor: item.laborCost,
        reason: item.reason,
        codeRefs: item.codeRefs,
        tier: item.tier,
        insuranceDefault: item.insuranceDefault,
        requiresPhoto: item.requiresPhoto
      };
    });
  }

  console.log(`[Xactimate Catalog] Loaded ${ITEMS.length} line items into window.NBD_XACT_CATALOG`);
})();
