// ══════════════════════════════════════════════════════════════
// NBD Pro — property-intel.js (ENHANCED)
// Property Intel: auditor lookup, intel cards, modal display
// Cloud Function proxy + free data sources + Roof Score
// ══════════════════════════════════════════════════════════════

// Use var to avoid redeclaration collision with dashboard.html inline script
let _NBD_PI_DELEGATE; // module-local (globals Tranche 1 — was window.*)
var _piCache = _piCache || {};

// HTML escape helper — prevents XSS when interpolating user data
// (owner names, addresses, auditor URLs) into innerHTML templates.
function _piEsc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ──────────────────────────────────────────────────────────────
// FREE DATA SOURCE HELPERS
// ──────────────────────────────────────────────────────────────

/**
 * Query US Census Geocoder for census tract and county FIPS
 * Returns { tract, tractId, countyFips, state }
 */
async function fetchCensusGeodata(address) {
  try {
    const res = await fetch(
      `https://geocoding.geo.census.gov/geocoder/geographies/address?street=${encodeURIComponent(address)}&format=json`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.result?.addressMatches?.length) return null;
    const match = data.result.addressMatches[0];
    const geo = match.geographies || {};
    const tract = geo['Census Tracts']?.[0];
    const county = geo['Counties']?.[0];
    return {
      tract: tract?.NAME || null,
      tractId: tract?.GEOID || null,
      countyFips: county?.GEOID || null,
      state: county?.STATE || null
    };
  } catch(e) {
    console.warn('Census geocoding failed:', e.message);
    return null;
  }
}

/**
 * Reverse geocode via Nominatim for neighborhood context (already used in D2D)
 * Returns { neighborhood, suburb, district }
 */
async function fetchNominatimContext(lat, lon) {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const addr = data.address || {};
    return {
      neighborhood: addr.neighbourhood || addr.suburb || null,
      suburb: addr.suburb || addr.town || null,
      district: addr.county || null
    };
  } catch(e) {
    console.warn('Nominatim reverse geocode failed:', e.message);
    return null;
  }
}

/**
 * Compute Roof Score (0-100) from available property data
 * Factors: roof age (major), property age, material type, storm history
 */
function computeRoofScore(intel) {
  let score = 100;
  const roofAge = intel.roofAge || 0;

  // Age-based deductions (roof lifespan ~20-30 years)
  if (roofAge >= 30) score -= 50;
  else if (roofAge >= 25) score -= 40;
  else if (roofAge >= 20) score -= 30;
  else if (roofAge >= 15) score -= 15;
  else if (roofAge >= 10) score -= 5;

  // Material factors (assume asphalt shingles by default)
  const material = (intel.roofMaterial || 'asphalt').toLowerCase();
  if (material.includes('metal')) score -= 5; // metal roofs last longer
  if (material.includes('tile') || material.includes('slate')) score -= 10;

  // Property age (if roof age not available)
  if (!intel.roofAge && intel.yearBuilt) {
    const propAge = new Date().getFullYear() - parseInt(intel.yearBuilt);
    if (propAge >= 40) score -= 25;
    else if (propAge >= 30) score -= 15;
  }

  // Storm history (placeholder for future integration)
  if (intel.stormHistory) score -= 10;

  return Math.max(0, Math.min(100, score));
}

/**
 * Determine action priority based on roof score and age
 */
function computeRecommendedAction(roofScore, roofAge) {
  if (roofScore <= 30) return 'High Priority';
  if (roofScore <= 60) return 'Follow Up';
  if (roofScore <= 80) return 'Low Priority';
  return 'Monitor';
}

/**
 * Estimate project value range based on sqft and roofing rates
 * Returns { min, max, perSqft }
 */
function estimateProjectValue(sqft, tier = 'better') {
  const rates = window.R || {
    good: 4.5,    // $/sqft base
    better: 6.5,
    best: 8.5
  };
  const baseRate = rates[tier] || 6.5;
  const perSqft = baseRate;
  const min = sqft * baseRate;
  const max = sqft * (baseRate * 1.2); // Allow 20% variance
  return { min, max, perSqft };
}

// ──────────────────────────────────────────────────────────────
// MAIN INTEL FETCH — uses Cloud Function proxy
// ──────────────────────────────────────────────────────────────

// Map a Regrid parcel record into the shape renderIntelCard expects.
// Regrid's fields are authoritative for owner/APN/acreage/sale data;
// roofAge + roofMaterial aren't in Regrid, so we derive what we can.
function _regridToIntel(p, auditorUrl, countyClean) {
  const yearBuilt = Number(p.yearBuilt) || null;
  const currentYear = new Date().getFullYear();
  // Best-effort roof age. Lacking maintenance records, assume roof
  // was last replaced 25 years after build, capped at "build year"
  // for homes newer than that. UI badges flag this as estimated.
  const roofAge = yearBuilt
    ? (currentYear - yearBuilt) > 25
      ? Math.min(currentYear - yearBuilt - 25, 30) // est since last replace
      : (currentYear - yearBuilt)                   // original roof
    : null;

  // Parse sale price/value strings — Regrid returns them as strings.
  const numOrNull = (v) => {
    if (v == null) return null;
    const n = Number(String(v).replace(/[,$\s]/g, ''));
    return isFinite(n) ? n : null;
  };

  return {
    ownerName:      p.owner || 'Unknown',
    isLLC:          /LLC|INC|TRUST|CORP|LP\b/i.test(p.owner || ''),
    yearBuilt:      yearBuilt,
    roofAge:        roofAge,
    roofMaterial:   'asphalt shingles', // default — Regrid doesn't know
    lastSaleDate:   p.lastSaleDate || null,
    lastSaleAmount: numOrNull(p.lastSalePrice),
    marketValue:    null,
    assessedValue:  numOrNull(p.assessedValue),
    propertyType:   null,
    bedrooms:       null,
    sqft:           numOrNull(p.sqft),
    acreage:        numOrNull(p.acres),
    homestead:      null,
    ownerOccupied:  null,
    taxDistrict:    p.schoolDist || null,
    parcelId:       p.parcelNumber || null,
    auditorUrl:     auditorUrl,
    county:         p.county || countyClean,
    city:           p.city || null,
    zip:            p.zip || null,
    stateAbbr:      p.stateAbbr || null,
    zoning:         p.zoning || null,
    // Audit batch 11 (2026-05-13): pass the parcel polygon through so
    // the lead save (crm.js:saveLead) can stamp it on the lead doc as
    // `parcel.geometry`. photo-smart-ingest.js:getPropertyPolygon reads
    // exactly that shape to power the photo-system Phase 2 slope
    // inference. Without this, every roof drawing + photo slope
    // suggestion silently falls back to heading-only mode.
    parcelGeometry: p.geometry || null,
    parcelCenter:   (p.lat != null && p.lng != null) ? { lat: Number(p.lat), lng: Number(p.lng) } : null
  };
}

async function fetchPropertyIntel(nominatimData, targetElId) {
  const targetEl = document.getElementById(targetElId);

  // Determine county from Nominatim response
  const addr = nominatimData?.address || {};
  const county = addr.county || addr.state_district || '';
  const countyClean = county.replace(' County','').trim();

  // Build the clean address for searching
  const num   = addr.house_number || '';
  const road  = addr.road || addr.street || '';
  const city  = addr.city || addr.town || addr.village || '';
  const state = addr.state_code || addr.state || 'OH';
  const zip   = addr.postcode || '';
  const fullAddr = [num+' '+road, city, state+' '+zip].map(s=>s.trim()).filter(Boolean).join(', ');
  const lat = nominatimData?.lat || null;
  const lon = nominatimData?.lon || null;

  // Cache check
  const cacheKey = fullAddr.toLowerCase().replace(/\s/g,'');
  if(_piCache[cacheKey]) {
    renderIntelCard(targetElId, _piCache[cacheKey], countyClean, fullAddr);
    return;
  }

  // Build the auditor URL based on county (moved above the Regrid
  // fast-path so _regridToIntel() can carry it through for the
  // "View on auditor site" link in the card).
  let auditorUrl = '';
  let searchUrl  = '';

  if(county.toLowerCase().includes('hamilton')) {
    const numEnc  = encodeURIComponent(num.toUpperCase());
    const roadEnc = encodeURIComponent(road.toUpperCase());
    auditorUrl = `https://wedge1.hcauditor.org/search/address/${numEnc}/${roadEnc}//1/10`;
    searchUrl  = auditorUrl;
  } else if(county.toLowerCase().includes('clermont')) {
    auditorUrl = `https://www.clermontauditor.org/real-estate/`;
    searchUrl  = `https://opendata.clermontauditor.org/resource/ti6j-ub22.json?$$app_token=&$where=situs_address+like+%27${encodeURIComponent(num+'%25')}%27&$limit=5`;
  } else if(county.toLowerCase().includes('warren')) {
    auditorUrl = `https://www.wcauditor.org/PropertySearch/`;
  } else if(county.toLowerCase().includes('butler')) {
    auditorUrl = `https://propertysearch.bcohio.gov/search/commonsearch.aspx?mode=address`;
  } else {
    auditorUrl = `https://www.hamiltoncountyauditor.org/`;
  }

  // Fast path: Regrid via NBDIntegrations.lookupParcel.
  // Structured, cheap, no LLM hallucinations. Fall through to the
  // Claude scrape path only when Regrid isn't configured or returns
  // a miss. Result shape is mapped to our standard `intel` object so
  // renderIntelCard doesn't know the difference.
  if (window.NBDIntegrations && typeof window.NBDIntegrations.lookupParcel === 'function') {
    try {
      const status = window._integrationStatus
        || (window.NBDIntegrations.status && await window.NBDIntegrations.status());
      if (status && status.configured && status.configured.regrid) {
        const res = await window.NBDIntegrations.lookupParcel(fullAddr);
        if (res && res.ok && res.parcel) {
          const intel = _regridToIntel(res.parcel, auditorUrl, countyClean);
          intel.dataSource = res.cached ? 'Regrid (cached)' : 'Regrid';
          _piCache[cacheKey] = intel;
          renderIntelCard(targetElId, intel, countyClean, fullAddr);
          return;
        }
      }
    } catch (e) {
      console.warn('[property-intel] Regrid path failed, falling through:', e && e.message);
    }
  }

  try {
    // Fetch free data sources in parallel
    const [censusData, nominatimContext] = await Promise.all([
      fetchCensusGeodata(fullAddr),
      lat && lon ? fetchNominatimContext(lat, lon) : Promise.resolve(null)
    ]);

    // Build Claude prompt with enriched context
    const prompt = `You are a property data extraction assistant for a roofing contractor app covering the Cincinnati, Ohio metro area.

Address: "${fullAddr}"
County: ${countyClean || 'unknown'}
${censusData?.tract ? `Census Tract: ${censusData.tract}` : ''}
${nominatimContext?.neighborhood ? `Neighborhood: ${nominatimContext.neighborhood}` : ''}

Return ONLY a valid JSON object (no markdown, no preamble):
{
  "ownerName": "FULL NAME OR LLC NAME",
  "isLLC": true/false,
  "yearBuilt": 1985,
  "roofAge": 40,
  "roofMaterial": "asphalt shingles",
  "lastSaleDate": "MM/DD/YYYY",
  "lastSaleAmount": 245000,
  "marketValue": 310000,
  "assessedValue": 108500,
  "propertyType": "Single Family",
  "bedrooms": 3,
  "sqft": 1850,
  "acreage": 0.25,
  "homestead": true,
  "ownerOccupied": true,
  "taxDistrict": "CINTI CORP",
  "parcelId": "040-0003-0039-00",
  "auditorUrl": "${auditorUrl}",
  "dataSource": "Hamilton County Auditor"
}

Find this data at: ${auditorUrl}
Use county records, tax assessor data, and MLS history if available.
Return best estimates with "dataSource": "estimated" if some fields are unavailable.`;

    // Call Cloud Function proxy instead of direct API
    const token = window._auth?.currentUser ?
      await window._auth.currentUser.getIdToken(true) : null;

    if (!token) {
      throw new Error('Not authenticated. Log in to use Property Intel.');
    }

    // Emulator switch (same Audit #3 rule as nbd-comms.js): otherwise this
    // always CORS-fails against prod when tested from localhost.
    const _functionsBase = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(
      (typeof location !== 'undefined' && location.hostname) || ''
    )
      ? 'http://127.0.0.1:5001/nobigdeal-pro/us-central1'
      : 'https://us-central1-nobigdeal-pro.cloudfunctions.net';
    const proxyResp = await fetch(`${_functionsBase}/claudeProxy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        messages: [{role: 'user', content: prompt}]
      })
    });

    if (!proxyResp.ok) {
      const errData = await proxyResp.json();
      throw new Error(errData.error || `API ${proxyResp.status}`);
    }

    const data = await proxyResp.json();
    let rawText = data?.content?.[0]?.text || '';

    // Parse JSON from response
    let intel = null;
    try {
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if(jsonMatch) intel = JSON.parse(jsonMatch[0]);
    } catch(e) {
      console.warn('Property intel JSON parse failed:', e.message);
    }

    if(!intel) throw new Error('No parseable data returned');

    // Compute roofAge if we have yearBuilt but not roofAge
    if(intel.yearBuilt && !intel.roofAge) {
      intel.roofAge = new Date().getFullYear() - parseInt(intel.yearBuilt);
    }

    // Enrich with computed fields
    intel.roofScore = computeRoofScore(intel);
    intel.recommendedAction = computeRecommendedAction(intel.roofScore, intel.roofAge || 0);
    intel.projectValue = estimateProjectValue(intel.sqft || 1500, 'better');
    intel.censusData = censusData;
    intel.neighborhood = nominatimContext?.neighborhood;

    _piCache[cacheKey] = intel;
    renderIntelCard(targetElId, intel, countyClean, fullAddr);

  } catch(err) {
    if(targetEl) {
      const card = targetEl.querySelector('.pi-card');
      const errHtml = `<div class="pi-card"><div class="pi-header"><span class="pi-title">🏠 Property Intel</span><span class="pi-county">${countyClean}</span></div><div class="pi-error">Could not load property data. ${err.message}<br><small>Make sure you're logged in and have an active subscription.</small></div></div>`;
      if(card) card.outerHTML = errHtml;
    }
    console.error('Property intel error:', err);
  }
}

function renderIntelCard(targetElId, intel, county, address) {
  const targetEl = document.getElementById(targetElId);
  if(!targetEl) return;

  // Store intel globally for pre-fill
  window._lastIntel = intel;

  const yr = intel.yearBuilt ? parseInt(intel.yearBuilt) : null;
  const age = yr ? (new Date().getFullYear() - yr) : null;
  const roofAge = intel.roofAge || age;
  const roofScore = intel.roofScore || 0;
  const recommendedAction = intel.recommendedAction || 'Monitor';
  const projectValue = intel.projectValue || { min: 0, max: 0 };

  let roofBadgeClass = 'pi-roof-mid';
  let roofLabel = '';
  if(roofAge !== null) {
    if(roofAge < 10)      { roofBadgeClass='pi-roof-new';     roofLabel=`${roofAge} yrs — Likely good`; }
    else if(roofAge < 20) { roofBadgeClass='pi-roof-mid';     roofLabel=`${roofAge} yrs — Watch it`; }
    else if(roofAge < 30) { roofBadgeClass='pi-roof-old';     roofLabel=`${roofAge} yrs — Needs attention`; }
    else                  { roofBadgeClass='pi-roof-ancient'; roofLabel=`${roofAge} yrs — Due for replacement`; }
  }

  // Roof Score color
  let scoreColor = '#2ECC8A';
  if (roofScore <= 30) scoreColor = '#FF6B6B';
  else if (roofScore <= 60) scoreColor = '#FFB84D';
  else if (roofScore <= 80) scoreColor = '#FFA500';

  // Action badge color
  let actionColor = '#999';
  let actionBgColor = '#f5f5f5';
  if (recommendedAction === 'High Priority') {
    actionColor = '#fff';
    actionBgColor = '#E05252';
  } else if (recommendedAction === 'Follow Up') {
    actionColor = '#fff';
    actionBgColor = '#FFA500';
  } else if (recommendedAction === 'Low Priority') {
    actionColor = '#333';
    actionBgColor = '#E8F4E8';
  }

  const ownerName  = intel.ownerName || 'Owner Unknown';
  const isLLC     = intel.isLLC || /LLC|INC|CORP|TRUST|PROPERTIES|HOLDINGS|INVESTMENTS/i.test(ownerName);
  const lastSale  = intel.lastSaleAmount ? '$'+parseInt(intel.lastSaleAmount).toLocaleString() : null;
  const mktVal    = intel.marketValue ? '$'+parseInt(intel.marketValue).toLocaleString() : null;
  const dataNote  = intel.dataSource === 'estimated' ? ' (est.)' : '';
  const projectValueStr = projectValue.min > 0
    ? `$${parseInt(projectValue.min).toLocaleString()} — $${parseInt(projectValue.max).toLocaleString()}`
    : 'Not available';

  const card = `<div class="pi-card">
    <div class="pi-header">
      <span class="pi-title">🏠 Property Intel${dataNote}</span>
      <span class="pi-county">${_piEsc(county || 'OH')} County</span>
    </div>
    <div class="pi-body">
      <div style="display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:8px;justify-content:space-between;">
        <div style="flex:1;">
          <div style="display:flex;align-items:center;gap:4px;margin-bottom:2px;flex-wrap:wrap;">
            <span class="pi-owner">${_piEsc(ownerName)}</span>
            ${isLLC ? '<span class="pi-llc-flag">🏢 LLC/Corp</span>' : ''}
          </div>
          <div class="pi-addr-line">${_piEsc(address)}</div>
        </div>
        <div style="text-align:right;min-width:120px;">
          <div style="font-size:11px;font-weight:700;color:var(--m);text-transform:uppercase;letter-spacing:.05em;margin-bottom:3px;">Roof Score</div>
          <div style="font-size:28px;font-weight:700;color:${scoreColor};">${roofScore}</div>
          <div style="font-size:9px;color:var(--m);">/ 100</div>
        </div>
      </div>
      ${roofAge !== null ? `<div class="pi-roof-badge ${roofBadgeClass}">🏠 ${roofLabel}</div>` : ''}
      <div style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
        <div style="background:${actionBgColor};color:${actionColor};padding:5px 10px;border-radius:5px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;">⭐ ${recommendedAction}</div>
        <div style="background:var(--s2);color:var(--m);padding:5px 10px;border-radius:5px;font-size:11px;">Est. Value: ${projectValueStr}</div>
      </div>
      <div class="pi-grid">
        ${yr ? `<div class="pi-stat"><span class="pi-stat-val">${yr}</span><span class="pi-stat-key">Year Built</span></div>` : ''}
        ${intel.propertyType ? `<div class="pi-stat"><span class="pi-stat-val">${_piEsc(intel.propertyType)}</span><span class="pi-stat-key">Type</span></div>` : ''}
        ${mktVal ? `<div class="pi-stat"><span class="pi-stat-val">${mktVal}</span><span class="pi-stat-key">Market Value</span></div>` : ''}
        ${lastSale ? `<div class="pi-stat"><span class="pi-stat-val">${lastSale}</span><span class="pi-stat-key">Last Sale</span></div>` : ''}
        ${intel.lastSaleDate ? `<div class="pi-stat"><span class="pi-stat-val">${_piEsc(intel.lastSaleDate)}</span><span class="pi-stat-key">Sale Date</span></div>` : ''}
        ${intel.bedrooms ? `<div class="pi-stat"><span class="pi-stat-val">${intel.bedrooms} bed</span><span class="pi-stat-key">Bedrooms</span></div>` : ''}
        ${intel.sqft ? `<div class="pi-stat"><span class="pi-stat-val">${parseInt(intel.sqft).toLocaleString()} sf</span><span class="pi-stat-key">Living Area</span></div>` : ''}
        ${intel.acreage ? `<div class="pi-stat"><span class="pi-stat-val">${parseFloat(intel.acreage).toFixed(3)} ac</span><span class="pi-stat-key">Acreage</span></div>` : ''}
        ${intel.homestead ? `<div class="pi-stat"><span class="pi-stat-val" style="color:var(--green);">Yes</span><span class="pi-stat-key">Homestead</span></div>` : ''}
        ${intel.parcelId ? `<div class="pi-stat"><span class="pi-stat-val" style="font-size:10px;">${_piEsc(intel.parcelId)}</span><span class="pi-stat-key">Parcel ID</span></div>` : ''}
      </div>
      <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">
        ${intel.auditorUrl && /^https?:\/\//i.test(intel.auditorUrl) ? `<a class="pi-link" href="${_piEsc(intel.auditorUrl)}" target="_blank" rel="noopener" style="flex:1;">↗ View County Record</a>` : ''}
        <button class="pi-lead-btn" data-pi-action="createLead" data-pi-address="${_piEsc(address)}" data-pi-owner="${_piEsc(ownerName)}" style="flex:1;padding:6px 12px;background:var(--orange);color:#fff;border:none;border-radius:5px;font-size:11px;font-weight:700;cursor:pointer;text-transform:uppercase;letter-spacing:.05em;">+ Create Lead</button>
        <button class="pi-lead-btn" data-pi-action="roofReport" title="Build a branded, homeowner-safe Roof Health Report and copy a share link" style="flex:1;padding:6px 12px;background:var(--s2);color:var(--t);border:1px solid var(--br);border-radius:5px;font-size:11px;font-weight:700;cursor:pointer;text-transform:uppercase;letter-spacing:.05em;">📄 Roof Report</button>
      </div>
    </div>
  </div>`;

  // Replace loading card, keep Make This a Lead button
  const existingCard = targetEl.querySelector('.pi-card');
  if(existingCard) {
    existingCard.outerHTML = card;
  } else {
    targetEl.innerHTML = card;
  }
}

/**
 * Create lead from property — called from intel card
 */
async function createLeadFromProperty(address, ownerName) {
  if (!window._lastIntel) {
    showToast('Property intel not loaded', 'error');
    return;
  }

  // Trigger lead creation modal with pre-filled intel
  if (typeof window.makeLeadFromSearch === 'function') {
    window.makeLeadFromSearch();
  } else {
    showToast('Lead creation not available', 'error');
  }
}

// ── Pull intel inside lead modal ──────────────────────────────
// PROPERTY INTEL SELECTIVE PULL SYSTEM
const pullIntelForModal = async function() {
  const addr = document.getElementById('lAddr')?.value?.trim();
  if(!addr) { showToast('Enter an address first','error'); return; }
  
  // Store address for later use
  window._pendingIntelAddress = addr;
  
  // Reset selections
  document.getElementById('piOwnerContact').checked = false;
  document.getElementById('piPropertyDetails').checked = false;
  document.getElementById('piZestimate').checked = false;
  document.getElementById('piTaxData').checked = false;
  updatePropertyIntelCost();
  
  // Show selection modal
  (function(){var m=document.getElementById('propertyIntelModal');m.style.display='flex';m.classList.add('open');})();
};

const closePropertyIntelModal = function () {
  (function(){var m=document.getElementById('propertyIntelModal');m.style.display='none';m.classList.remove('open');})();
};

const closePropertyIntelConfirmModal = function () {
  (function(){var m=document.getElementById('propertyIntelConfirmModal');m.style.display='none';m.classList.remove('open');})();
};

const updatePropertyIntelCost = function() {
  const prices = {
    piOwnerContact: 0.30,
    piPropertyDetails: 0.15,
    piZestimate: 0.05,
    piTaxData: 0.10
  };
  
  let total = 0;
  for (const [id, price] of Object.entries(prices)) {
    if (document.getElementById(id)?.checked) {
      total += price;
    }
  }
  
  document.getElementById('piTotalCost').textContent = '$' + total.toFixed(2);
  
  // Disable pull button if nothing selected
  const btn = document.getElementById('piPullBtn');
  if (total === 0) {
    btn.disabled = true;
    btn.style.opacity = '0.5';
    btn.style.cursor = 'not-allowed';
  } else {
    btn.disabled = false;
    btn.style.opacity = '1';
    btn.style.cursor = 'pointer';
  }
};

const confirmPropertyIntelPull = function() {
  const selections = {
    'Owner Name & Contact': document.getElementById('piOwnerContact').checked,
    'Property Details': document.getElementById('piPropertyDetails').checked,
    'Zillow Zestimate': document.getElementById('piZestimate').checked,
    'Tax Assessor Data': document.getElementById('piTaxData').checked
  };
  
  const selected = Object.entries(selections).filter(([_, checked]) => checked).map(([name, _]) => name);
  
  if (selected.length === 0) {
    showToast('Select at least one data source', 'error');
    return;
  }
  
  // Calculate cost
  const prices = { 'Owner Name & Contact': 0.30, 'Property Details': 0.15, 'Zillow Zestimate': 0.05, 'Tax Assessor Data': 0.10 };
  const cost = selected.reduce((sum, name) => sum + prices[name], 0);
  
  // Update confirmation modal
  document.getElementById('piConfirmCost').textContent = '$' + cost.toFixed(2);
  const listEl = document.getElementById('piConfirmList');
  listEl.innerHTML = selected.map(name => `<li>${name}</li>`).join('');
  
  // Hide selection modal, show confirmation
  (function(){var m=document.getElementById('propertyIntelModal');m.style.display='none';m.classList.remove('open');})();
  (function(){var m=document.getElementById('propertyIntelConfirmModal');m.style.display='flex';m.classList.add('open');})();
};

const executePullPropertyIntel = async function() {
  const confirmBtn = document.getElementById('piConfirmBtn');
  const originalText = confirmBtn.textContent;
  confirmBtn.disabled = true;
  confirmBtn.textContent = '⏳ Pulling...';
  
  try {
    const addr = window._pendingIntelAddress;
    if (!addr) throw new Error('No address found');
    
    // Get selections
    const selections = {
      ownerContact: document.getElementById('piOwnerContact').checked,
      propertyDetails: document.getElementById('piPropertyDetails').checked,
      zestimate: document.getElementById('piZestimate').checked,
      taxData: document.getElementById('piTaxData').checked
    };
    
    // Calculate actual cost
    const prices = { ownerContact: 0.30, propertyDetails: 0.15, zestimate: 0.05, taxData: 0.10 };
    const cost = Object.entries(selections)
      .filter(([_, checked]) => checked)
      .reduce((sum, [key, _]) => sum + prices[key], 0);
    
    // Geocode address first
    const geo = await geocode(addr);
    if (!geo) throw new Error('Could not geocode address');
    
    // Per-checkbox-driven property API calls aren't wired up yet — the
    // current backend has a single property-intel endpoint that returns
    // everything at once (free public data + Nominatim). Until per-source
    // metering exists (e.g. Estated, ATTOM, BatchSkipTracing all priced
    // separately), the checkbox UI is informational only — we run the
    // single fetchPropertyIntelModal() pull and ignore the per-source
    // selections. The cost displayed below is therefore the AGGREGATE
    // cost of the pull, not per-source.
    //
    // Future: when paid sources are added, replace this single call with
    // a Promise.allSettled over the selected sources, and bill per-source
    // via Stripe metered usage.
    await fetchPropertyIntelModal(geo, addr);
    
    // Close modals
    closePropertyIntelConfirmModal();
    
    // Show success with cost
    const selectedCount = Object.values(selections).filter(Boolean).length;
    showToast(`✓ Pulled ${selectedCount} data point${selectedCount > 1 ? 's' : ''} for $${cost.toFixed(2)}`, 'success');
    
  } catch (error) {
    console.error('Property intel pull error:', error);
    showToast('Failed to pull property data: ' + error.message, 'error');
  } finally {
    confirmBtn.disabled = false;
    confirmBtn.textContent = originalText;
  }
};

async function fetchPropertyIntelModal(geo, addr) {
  const resultEl = document.getElementById('modalIntelResult');
  const gAddr = geo.address || {};
  const county = (gAddr.county||'').replace(' County','').trim();

  // Run same engine but capture result for modal
  const cacheKey = addr.toLowerCase().replace(/\s/g,'');
  let intel = _piCache[cacheKey] || null;

  if(!intel) {
    // Temporarily show result container
    resultEl.innerHTML = '<div style="color:var(--m);font-size:11px;">Estimating property profile...</div>';
    resultEl.classList.add('visible');
    // Fire the intel engine with a temp container
    const tempId = 'pi-temp-' + Date.now();
    const tempDiv = document.createElement('div');
    tempDiv.id = tempId;
    tempDiv.style.display = 'none';
    document.body.appendChild(tempDiv);
    await fetchPropertyIntel(geo, tempId);
    intel = window._lastIntel || null;
    document.body.removeChild(tempDiv);
  }

  if(!intel) {
    resultEl.innerHTML = '<div style="color:var(--red);font-size:11px;">Could not retrieve property data. Check your API key in Settings.</div>';
    resultEl.classList.add('visible');
    return;
  }

  // Pre-fill lead modal fields
  if(intel.ownerName && intel.ownerName !== 'Owner Unknown') {
    const parts = intel.ownerName.trim().split(/\s+/);
    const fname = document.getElementById('lFname');
    const lname = document.getElementById('lLname');
    if(fname && !fname.value) {
      if(parts.length >= 2) {
        fname.value = parts[0];
        lname.value = parts.slice(1).join(' ');
      } else {
        fname.value = intel.ownerName;
      }
    }
  }

  // Build notes pre-fill
  const notesEl = document.getElementById('lNotes');
  if(notesEl && !notesEl.value) {
    const yr = intel.yearBuilt;
    const age = yr ? (new Date().getFullYear() - parseInt(yr)) : null;
    const lines = [];
    if(yr) lines.push(`Year Built: ${yr} (${age} yr old roof)`);
    if(intel.ownerName) lines.push(`Owner of Record: ${intel.ownerName}`);
    if(intel.propertyType) lines.push(`Property: ${intel.propertyType}`);
    if(intel.marketValue) lines.push(`Market Value: $${parseInt(intel.marketValue).toLocaleString()}`);
    if(intel.lastSaleDate && intel.lastSaleAmount) lines.push(`Last Sale: $${parseInt(intel.lastSaleAmount).toLocaleString()} on ${intel.lastSaleDate}`);
    if(intel.isLLC) lines.push('Owner is LLC/Corporate entity');
    notesEl.value = lines.join('\n');
  }

  // Store yearBuilt for Firestore save
  window._modalIntel = intel;

  // Show compact result card
  const yr = intel.yearBuilt;
  const age = yr ? (new Date().getFullYear() - parseInt(yr)) : null;
  const roofAge = intel.roofAge || age;
  let roofColor = '#EAB308';
  if(roofAge !== null) {
    if(roofAge < 10) roofColor = '#2ECC8A';
    else if(roofAge < 20) roofColor = '#EAB308';
    else if(roofAge < 30) roofColor = '#E05252';
    else roofColor = '#9B6DFF';
  }

  resultEl.innerHTML = `
    <div class="mir-owner">${intel.ownerName||'Unknown Owner'}${intel.isLLC?'&nbsp;<span style="font-size:9px;color:#4A9EFF;font-weight:700;">LLC</span>':''}</div>
    <div class="mir-grid">
      ${yr ? `<div class="mir-item">Built <span>${yr}</span></div>` : ''}
      ${roofAge !== null ? `<div class="mir-item">Roof <span style="color:${roofColor};">${roofAge} yrs</span></div>` : ''}
      ${intel.marketValue ? `<div class="mir-item">Value <span>$${parseInt(intel.marketValue).toLocaleString()}</span></div>` : ''}
      ${intel.propertyType ? `<div class="mir-item">Type <span>${intel.propertyType}</span></div>` : ''}
      ${intel.bedrooms ? `<div class="mir-item">Beds <span>${intel.bedrooms}</span></div>` : ''}
      ${intel.homestead ? `<div class="mir-item">Homestead <span style="color:#2ECC8A;">Yes</span></div>` : ''}
    </div>
    <div style="font-size:10px;color:var(--m);margin-top:5px;">✓ Owner name and notes pre-filled below</div>`;
  resultEl.classList.add('visible');
}

// opts.quiet: no toast on a miss (see dashboard-api.js geocode — same
// contract; whichever loads last owns the global).
async function geocode(q, opts){
  const quiet = !!(opts && opts.quiet);
  try{
    // 5s cap: _saveLead awaits this on every new lead with an address, and
    // Nominatim rate-limits/black-holes some IPs with no response — without
    // a timeout the whole save hangs in the field (found via the authed E2E
    // suite, 2026-07-04). Abort → the catch below → save proceeds pin-less.
    const res=await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1&addressdetails=1`,{signal:AbortSignal.timeout(5000)});
    const d=await res.json();
    if(!d.length){if(!quiet)showToast('Address not found','error');return null;}
    return d[0];
  }catch(e){if(!quiet)showToast('Geocode failed','error');return null;}
}


// Window scope exposures for Property Intel
window.fetchPropertyIntel = fetchPropertyIntel;
window.renderIntelCard = renderIntelCard;
window.fetchPropertyIntelModal = fetchPropertyIntelModal;

// Globals Tranche 2c-4h Slice H2 part 2 (2026-07-08): property-intel.js is now the
// SOLE owner of the selective-pull cluster — the byte-identical dashboard-ui.js
// twins were deleted (property-intel.js already won on window, loading last). These
// 4 move off window into __NBD_CALL_REGISTRY, which the dashboard-ui.js dispatchers
// resolve FIRST; their _NBD_CALL_ALLOWLIST entries are dropped. The lone explicit
// window export (of executePullPropertyIntel) is dropped with them.
// Tranche 3 dispatch-map slice (2026-09-02): the last two twins followed —
// closePropertyIntelModal / closePropertyIntelConfirmModal are sole-owned here
// as top-level consts and registered below; their only dispatch is the
// _NBD_MODAL_CLOSE_FNS map (registry-first since T3-M), plus one in-file bare
// call to the confirm-close which resolves lexically.
window.__NBD_CALL_REGISTRY = window.__NBD_CALL_REGISTRY || Object.create(null);
Object.assign(window.__NBD_CALL_REGISTRY, {
  pullIntelForModal: pullIntelForModal,
  updatePropertyIntelCost: updatePropertyIntelCost,
  confirmPropertyIntelPull: confirmPropertyIntelPull,
  executePullPropertyIntel: executePullPropertyIntel,
  closePropertyIntelModal: closePropertyIntelModal,
  closePropertyIntelConfirmModal: closePropertyIntelConfirmModal
});


// Build a branded, homeowner-safe Roof Health Report from the current property
// intel and share it via the SAME reports/{id} + createReportShareToken pipeline
// the inspection engine uses (no new Cloud Function). White-label via _brand().
async function shareRoofReport() {
  const intel = window._lastIntel;
  if (!intel) { if (window.showToast) window.showToast('Look up a property first', 'info'); return; }
  const RR = window.RoofReport;
  // InspectionReportEngine ships in the LAZY 'photos' bundle (script-loader.js),
  // which only loads on the Photos view or a card-detail photo/camera button.
  // This card is a modal reachable from anywhere, so on a fresh session the
  // engine isn't here yet — and dashboard-actions.js installs a lazy STUB
  // ({__nbdLazyPhotosStub:true, openBuilder}) that is truthy but has no
  // saveReport, so the guard below used to bail with "engine not ready" and the
  // 📄 button looked broken unless the rep had already opened Photos. Same
  // stub-vs-real trap as the photo hub (#1114): load the bundle, then RE-READ
  // the global, because the real engine replaces the stub on load.
  let Engine = window.InspectionReportEngine;
  const engineReady = (e) => !!e && !e.__nbdLazyPhotosStub && typeof e.saveReport === 'function';
  if (!engineReady(Engine) && window.ScriptLoader && typeof window.ScriptLoader.loadBundle === 'function') {
    if (window.showToast) window.showToast('Loading the report engine…', 'info');
    try { await window.ScriptLoader.loadBundle('photos'); } catch (_) { /* fall through to the guard */ }
    Engine = window.InspectionReportEngine;
  }
  if (!RR || typeof RR.buildRoofReportHtml !== 'function' || !engineReady(Engine)) {
    if (window.showToast) window.showToast('Roof Report engine not ready', 'error');
    return;
  }
  try {
    const b = (window._brand && window._brand()) || {};
    const brand = {
      name: b.name || b.companyName || (window.companyProfile && window.companyProfile.name) || '',
      logoUrl: b.logo || b.logoUrl || b.logoURL || '',
      accent: b.accent || b.primaryColor || b.color || '',
      repName: (window._currentUser && window._currentUser.displayName) || (window._user && window._user.displayName) || '',
      repPhone: (window.companyProfile && window.companyProfile.phone) || b.phone || '',
    };
    let dateStr = '';
    try { dateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }); } catch (_) {}
    const html = RR.buildRoofReportHtml(intel, brand, { dateStr });
    if (window.showToast) window.showToast('Building roof report…', 'info');
    const leadId = intel.leadId || (window._currentLead && window._currentLead.id) || null;
    const reportId = await Engine.saveReport(leadId, 'roof-health', {
      html,
      data: intel,
      propertyAddress: intel.address || intel.propertyAddress || '',
    });
    if (reportId && typeof Engine._shareReport === 'function') await Engine._shareReport(reportId);
  } catch (e) {
    console.error('[property-intel] shareRoofReport failed:', e);
    if (window.showToast) window.showToast('Could not build roof report', 'error');
  }
}

(function(){if(_NBD_PI_DELEGATE)return;_NBD_PI_DELEGATE=true;document.addEventListener('click',function(ev){var t=ev.target.closest&&ev.target.closest('[data-pi-action]');if(!t)return;var a=t.dataset.piAction;if(a==='createLead'&&typeof createLeadFromProperty==='function')createLeadFromProperty(t.dataset.piAddress,t.dataset.piOwner);else if(a==='roofReport'&&typeof shareRoofReport==='function')shareRoofReport();});})();
