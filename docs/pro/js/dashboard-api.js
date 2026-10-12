/**
 * dashboard-api.js — Firestore reads/writes + outbound network
 * calls for the dashboard surface.
 *
 * Extracted from dashboard-main.js (Step 4a — 2026-05-16). Second
 * in the state→api→widgets→ui→actions→main load chain.
 *
 * Lives here (no DOM render, no event wiring):
 *   - photo count cache (Firestore photos query)
 *   - storm alerts pull (weather.gov)
 *   - leaderboard query (Firestore knocks)
 *   - property intel via Claude (window.callClaude)
 *   - geocode + Nominatim autocomplete fetch
 *   - document save + load (Firestore documents collection)
 *   - GDPR export / erasure (Functions)
 *   - portal link share / revoke (Functions)
 *
 * Many functions read from / write to globals defined in
 * dashboard-state.js (currentPhotoLeadId, _piCache, _acCache,
 * _docFile). Don't reorder load — state must initialise first.
 */

// ══════════════════════════════════════════════
// PHOTO COUNTS — Firestore aggregate
// ══════════════════════════════════════════════
async function loadPhotoCounts() {
  if (window._photoCountsLoaded) return window._photoCountByLead;
  try {
    const uid = window._user?.uid;
    if (!uid) return {};
    // One Firestore read — all photos owned by this user. We only
    // need the leadId field, so we don't pull the actual photo data.
    const snap = await getDocs(query(
      collection(db, 'photos'),
      where('userId', '==', uid)
    ));
    const counts = {};
    snap.forEach(d => {
      const data = d.data();
      const lid = data.leadId;
      if (lid) counts[lid] = (counts[lid] || 0) + 1;
    });
    window._photoCountByLead = counts;
    window._photoCountsLoaded = true;
    return counts;
  } catch (e) {
    console.warn('[Photos Near Me] loadPhotoCounts failed:', e.message);
    return {};
  }
}

// ══════════════════════════════════════════════
// LEADERBOARD — Firestore knocks query
// ══════════════════════════════════════════════
async function renderLeaderboard(){
  const WON = ['closed','install_complete','final_photos','final_payment','deductible_collected','Complete'];
  const leads = window._leads || [];
  const db = window._db || window.db;
  const uid = window._user?.uid;
  const lbEl = document.getElementById('lbRows');
  if (!lbEl) return;

  // Metrics audit F4: attribute by the lead's OWNER (userId), never by
  // display name. The old `repName || viewer's displayName` keying folded
  // every unlabeled lead into whichever account was looking at the screen —
  // and with team visibility shipping the whole tenant book, a manager
  // opening the leaderboard absorbed every teammate's repName-less leads.
  // repName is display-only now: best repName seen on that owner's leads,
  // else "You" for the viewer, else a short owner tag for a teammate.
  const wonRole = (l) => {
    const r = l._stageRole
      || (typeof window.stageRole === 'function' ? window.stageRole(l._stageKey || l.stage) : '');
    // F8: in-production (job role) is won money, same as crm closedRev.
    if (r) return r === 'won' || r === 'job';
    return WON.includes(l._stageKey || l.stage || '');
  };
  const reps = {};
  leads.filter(l => !l.deleted).forEach(l => {
    const owner = l.userId || '(unknown)';
    if (!reps[owner]) reps[owner] = { owner, name: '', leads: 0, won: 0, revenue: 0, knocks: 0 };
    if (!reps[owner].name && l.repName) reps[owner].name = l.repName;
    reps[owner].leads++;
    if (wonRole(l)) {
      reps[owner].won++;
      reps[owner].revenue += parseFloat(l.jobValue) || 0;
    }
  });
  // Teammate names from the company roster (team-names.js). Without it a rep
  // whose leads carry no repName showed as "Teammate Y6HCf6" — a uid fragment
  // (CRM sweep R14, 2026-09-28). A refused roster read falls back as before.
  if (window.NBDTeamNames) { try { await window.NBDTeamNames.load(); } catch (_) {} }
  Object.values(reps).forEach(r => {
    if (r.name) return;
    const rosterName = window.NBDTeamNames ? window.NBDTeamNames.nameFor(r.owner) : null;
    if (rosterName) r.name = rosterName;
    else if (r.owner === uid) r.name = window._user?.displayName || 'You';
    else if (r.owner === '(unknown)') r.name = 'Unassigned';
    else r.name = 'Teammate ' + String(r.owner).slice(0, 6);
  });

  // Enrich with knock data. The knocks query is scoped to the VIEWER (the
  // /knocks read rule is owner-or-manager), so the count lands on the
  // viewer's own row only — the old code dumped it on whichever rep
  // happened to be first in object-key order.
  if (db && uid) {
    try {
      const snap = await window.getDocs(window.query(window.collection(db, 'knocks'), window.where('userId', '==', uid)));
      const knockCount = snap.size;
      // Only materialize the viewer's row when there is real knock data —
      // the unconditional insert made the empty state below unreachable and
      // handed a brand-new tenant a gold medal at 0 leads / 0 knocks.
      if (knockCount > 0) {
        if (!reps[uid]) reps[uid] = { owner: uid, name: window._user?.displayName || 'You', leads: 0, won: 0, revenue: 0, knocks: 0 };
        reps[uid].knocks = knockCount;
      }
    } catch (e) { /* knocks may not have index — skip */ }
  }

  // If still empty show a friendly message
  if (!Object.keys(reps).length) {
    lbEl.innerHTML = '<div style="text-align:center;padding:32px 16px;color:var(--m);font-size:13px;"><div style="font-size:28px;margin-bottom:8px;">📊</div>No data yet. Close deals to appear on the leaderboard.</div>';
    return;
  }

  const sorted = Object.values(reps).sort((a, b) => b.won - a.won || b.revenue - a.revenue);
  const medals = ['🥇', '🥈', '🥉'];
  const maxWon = sorted[0]?.won || 1;

  const esc = window.nbdEsc || (s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c])));
  lbEl.innerHTML = sorted.map((r, i) => {
    const rateStr = r.leads ? Math.round(r.won / r.leads * 100) + '%' : '—';
    const revStr = r.revenue > 0 ? '$' + (r.revenue >= 1000 ? (r.revenue / 1000).toFixed(1) + 'K' : Math.round(r.revenue)) : '$0';
    const barW = Math.round((r.won / maxWon) * 100);
    const knockStr = r.knocks > 0 ? ' · ' + Number(r.knocks) + ' doors' : '';
    return '<div style="display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--br);">' +
      '<div style="font-size:20px;width:28px;text-align:center;">' + (medals[i] || '#' + (i + 1)) + '</div>' +
      '<div style="flex:1;">' +
        '<div style="font-size:13px;font-weight:600;">' + esc(r.name) + '</div>' +
        '<div style="font-size:11px;color:var(--m);">' + Number(r.leads || 0) + ' leads · ' + Number(r.won || 0) + ' won · ' + esc(rateStr) + ' close rate' + esc(knockStr) + '</div>' +
        '<div style="background:var(--s3);border-radius:4px;height:5px;margin-top:6px;overflow:hidden;"><div style="height:100%;border-radius:4px;background:var(--orange);width:' + barW + '%;transition:width .6s;"></div></div>' +
      '</div>' +
      '<div style="text-align:right;">' +
        '<div style="font-family:\'Barlow Condensed\',sans-serif;font-size:20px;font-weight:700;color:var(--orange);">' + r.won + ' <span style="font-size:11px;color:var(--m);">WON</span></div>' +
        '<div style="font-size:10px;color:var(--m);margin-top:2px;">' + revStr + ' booked</div>' +
      '</div>' +
    '</div>';
  }).join('');
}

// ══════════════════════════════════════════════
// PROPERTY INTEL ENGINE — Claude proxy
// ══════════════════════════════════════════════
// County → auditor URL builder
function getAuditorUrl(county, address, nominatimData) {
  const c = (county||'').toLowerCase();
  if(c.includes('hamilton')) {
    // Hamilton County: use address search page
    const a = nominatimData?.address || {};
    const num  = (a.house_number||'').toUpperCase();
    const road = (a.road||a.street||'').toUpperCase().replace(/\s+/g,' ').trim();
    return `https://wedge1.hcauditor.org/search/address/${encodeURIComponent(num)}/${encodeURIComponent(road)}//1/10`;
  }
  if(c.includes('clermont')) {
    return `https://www.wcauditor.org/PropertySearch/`; // fallback — Clermont uses different system
  }
  if(c.includes('warren')) {
    return `https://www.wcauditor.org/PropertySearch/`;
  }
  if(c.includes('butler')) {
    const a = nominatimData?.address || {};
    const num  = (a.house_number||'').toUpperCase();
    const road = (a.road||a.street||'').toUpperCase();
    return `https://propertysearch.bcohio.gov/search/commonsearch.aspx?mode=address`;
  }
  return null;
}

// Determine direct summary URL for Hamilton (most used county)
function getHamiltonSummaryUrl(parcelId) {
  // Hamilton parcel IDs look like: 040-0003-0039-00
  // URL: wedge1.hcauditor.org/view/re/0400003003900/2024/summary
  const clean = parcelId.replace(/-/g,'').replace(/\s/g,'');
  return `https://wedge1.hcauditor.org/view/re/${clean}/2024/summary`;
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

  // Cache check
  const cacheKey = fullAddr.toLowerCase().replace(/\s/g,'');
  if(_piCache[cacheKey]) {
    renderIntelCard(targetElId, _piCache[cacheKey], countyClean, fullAddr);
    return;
  }

  // Build the auditor URL based on county
  let auditorUrl = '';
  let searchUrl  = '';

  if(county.toLowerCase().includes('hamilton')) {
    const numEnc  = encodeURIComponent(num.toUpperCase());
    const roadEnc = encodeURIComponent(road.toUpperCase());
    // Hamilton address search returns list with parcel IDs
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
    // Unknown county — use Claude to try to find it
    auditorUrl = `https://www.hamiltoncountyauditor.org/`;
  }

  // ── Claude-powered extraction ─────────────────────────────────
  // For Hamilton we can fetch the search page HTML and parse parcel ID,
  // then fetch the summary page. For others, we ask Claude to help interpret.

  try {
    // Step 1: Ask Claude to look up the property data
    const prompt = `You are a property data extraction assistant for a roofing contractor app covering the Cincinnati, Ohio metro area (Hamilton, Clermont, Warren, Butler counties).

The user needs property intel for this address: "${fullAddr}"
County: ${countyClean || 'unknown — likely Hamilton or Clermont, OH'}

Your job: Return ONLY a valid JSON object with these fields (use null for unknown):
{
  "ownerName": "FULL NAME OR LLC NAME",
  "isLLC": true/false,
  "yearBuilt": 1985,
  "roofAge": 40,
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

To find this data, use the Hamilton County auditor search at: ${auditorUrl}
The page at wedge1.hcauditor.org/search/address/[HOUSE_NUMBER]/[STREET_NAME]//1/10 returns matching parcels.
Then wedge1.hcauditor.org/view/re/[PARCEL_ID_NO_DASHES]/2024/summary has the full record.

For the address "${fullAddr}", search the auditor, find the parcel, and extract all available fields.
If you cannot access the page, return your best estimate with "dataSource": "estimated" and null for unknown fields.
RETURN ONLY THE JSON OBJECT. No explanation, no markdown, no preamble.`;

    if (!window.callClaude) {
      throw new Error('Claude proxy not loaded. Refresh the page and try again.');
    }

    const data = await window.callClaude({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{role: 'user', content: prompt}]
    });

    // Extract text from Anthropic response
    let rawText = data?.content?.[0]?.text || '';

    // Parse JSON from response
    let intel = null;
    try {
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if(jsonMatch) intel = JSON.parse(jsonMatch[0]);
    } catch(e) {}

    if(!intel) throw new Error('No parseable data returned');

    // Compute roofAge if we have yearBuilt but not roofAge
    if(intel.yearBuilt && !intel.roofAge) {
      intel.roofAge = new Date().getFullYear() - parseInt(intel.yearBuilt);
    }

    _piCache[cacheKey] = intel;
    renderIntelCard(targetElId, intel, countyClean, fullAddr);

  } catch(err) {
    if(targetEl) {
      const card = targetEl.querySelector('.pi-card');
      const errHtml = `<div class="pi-card"><div class="pi-header"><span class="pi-title">🏠 Property Intel</span><span class="pi-county">${countyClean}</span></div><div class="pi-error">Could not load property data. Check your API key or try again.<br><small>${err.message}</small></div></div>`;
      if(card) card.outerHTML = errHtml;
    }
  }
}

// ══════════════════════════════════════════════
// GEOCODE — Nominatim single-result lookup
// ══════════════════════════════════════════════
// opts.quiet: no toast on a miss. Background callers (map layers geocoding
// every lead, the lead save) pass it — a red "Address not found" per
// unmappable lead read as a failed save / an error storm.
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

// ══════════════════════════════════════════════
// ADDRESS AUTOCOMPLETE — Nominatim suggestions fetch
// ══════════════════════════════════════════════
async function fetchAcSuggestions(inputId, q, onSelect) {
  const drop = document.getElementById('ac-' + inputId);
  if(!drop) return;

  // Cache hit
  if(_acCache[q]) { renderAcDrop(inputId, _acCache[q], onSelect); return; }

  drop.innerHTML = '<div class="ac-spinner">Searching...</div>';
  drop.style.display = 'block';

  try {
    // Bias to Ohio/Cincinnati area for better local results
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=6&addressdetails=1&countrycodes=us&viewbox=-84.9,38.4,-83.6,39.7&bounded=0`;
    const res = await fetch(url);
    const data = await res.json();
    _acCache[q] = data;
    renderAcDrop(inputId, data, onSelect);
  } catch(e) {
    drop.style.display = 'none';
  }
}

// ══════════════════════════════════════════════
// DOCUMENT LIBRARY — Firestore documents
// ══════════════════════════════════════════════
async function saveDocUpload(){
  const name = document.getElementById('docName')?.value.trim();
  const cat  = document.getElementById('docCategory')?.value;
  if(!name||!_docFile){ showToast('Add a name and select a file','error'); return; }
  try {
    const storageRef = window._storage.ref ? window._storage.ref('docs/'+Date.now()+'_'+_docFile.name) : null;
    if(storageRef){
      await uploadBytes(storageRef, _docFile);
      const url = await getDownloadURL(storageRef);
      await addDoc(collection(window._db,'documents'), {name,category:cat,url,fileName:_docFile.name,createdAt:serverTimestamp(),userId:window._user?.uid});
    }
    showToast('Document uploaded!','ok');
    closeUploadDoc();
    loadDocs();
  } catch(e){ showToast('Upload failed — '+e.message,'error'); }
}
async function loadDocs(){
  try {
    const wrap = document.getElementById('uploadedDocsWrap');
    if(!wrap) return;
    const _duid = window._user?.uid;
    if (!_duid) { wrap.innerHTML='<div class="empty"><div class="empty-icon">📁</div>No documents yet.</div>'; return; }
    const snap = await getDocs(query(collection(window._db,'documents'), window.where('userId','==',_duid)));
    const docs = snap.docs.map(d=>({id:d.id,...d.data()}));
    if(!docs.length){ wrap.innerHTML='<div class="empty"><div class="empty-icon">📁</div>No uploaded documents yet.</div>'; return; }
    const esc = window.nbdEsc || (s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c])));
    wrap.innerHTML = docs.map(d=>{
      // Only allow http(s) URLs — prevents javascript: and data: schemes.
      const safeUrl = /^https?:/i.test(d.url || '') ? d.url : '#';
      return `
      <div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--br);">
        <div style="font-size:20px;">📄</div>
        <div style="flex:1;"><div style="font-weight:600;font-size:13px;">${esc(d.name)}</div><div style="font-size:10px;color:var(--m);">${esc(d.category)} · ${esc(d.fileName||'')}</div></div>
        <a href="${esc(safeUrl)}" target="_blank" rel="noopener noreferrer" class="btn btn-ghost" style="font-size:11px;padding:5px 10px;">Open</a>
      </div>`;
    }).join('');
  } catch(e){ console.error('loadDocs error:',e); }
}

// ══════════════════════════════════════════════
// GDPR — Article 20 (export) + Article 17 (erasure)
// ══════════════════════════════════════════════
// D6/D7 from the enterprise-hardening sprint landed the server
// callables but no UI called them. These two helpers fix that.
window._gdprExport = async function () {
  if (!window._user) { if (typeof showToast==='function') showToast('Sign in first','error'); return; }
  // native confirm() is patched to silently return true in PWA mode
  // (standalone-compat.js), so route through nbdConfirm to get a real Cancel.
  // Auto-YES here burns one of the two exports allowed per 24h and mints a
  // signed URL holding every record on the account, live for a day.
  const ask = window.nbdConfirm || ((m) => Promise.resolve(window.confirm(m)));
  if (!(await ask('Download a JSON file containing every record tied to your account (profile, leads, estimates, photos, pins, tasks, documents, api_usage). The download link expires in 24 hours.\n\nProceed?'))) return;
  try {
    const mod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js');
    const fn = mod.httpsCallable(mod.getFunctions(), 'exportMyData');
    if (typeof showToast==='function') showToast('Building export… this can take up to a minute.', 'info');
    const res = await fn({});
    const url = res && res.data && res.data.url;
    if (!url) throw new Error('No URL returned');
    // Open in a new tab so the user can save the JSON themselves.
    window.open(url, '_blank', 'noopener');
    if (typeof showToast==='function') showToast('✓ Export ready — opening download.', 'success');
  } catch (e) {
    console.error('gdpr export failed', e);
    if (typeof showToast==='function') showToast(e.message || 'Export failed', 'error');
  }
};

window._gdprRequestErasure = async function () {
  if (!window._user) { if (typeof showToast==='function') showToast('Sign in first','error'); return; }
  const warning =
    'PERMANENTLY DELETE YOUR ACCOUNT?\n\n' +
    'This will delete every lead, estimate, photo, pin, task, note, and profile record you own. ' +
    'Your account will be disabled. This CANNOT be undone.\n\n' +
    'We will email you a confirmation link. The deletion only completes when you click it ' +
    'within 24 hours. If the email doesn\'t arrive, check spam.';
  // native confirm() is patched to silently return true in PWA mode
  // (standalone-compat.js), so route through nbdConfirm to get a real Cancel.
  const ask = window.nbdConfirm || ((m) => Promise.resolve(window.confirm(m)));
  if (!(await ask(warning))) return;
  try {
    const mod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js');
    const fn = mod.httpsCallable(mod.getFunctions(), 'requestAccountErasure');
    await fn({});
    if (typeof showToast==='function') showToast('Confirmation email sent. Click the link within 24h to complete deletion.', 'success');
  } catch (e) {
    console.error('gdpr erasure request failed', e);
    if (typeof showToast==='function') showToast(e.message || 'Request failed', 'error');
  }
};

// ══════════════════════════════════════════════
// PORTAL LINK — Share / Revoke
// ══════════════════════════════════════════════
// ── Revoke &amp; Regenerate Portal Link ─────────────────
// B4 + B5: first call revokePortalToken to invalidate every live
// token for this lead, then mint a fresh one and open the SMS
// prefilled exactly like _sharePortalLink. Use when a rep suspects
// a link was leaked or forwarded.
window._revokePortalLink = async function (leadId) {
  if (!leadId) return;
  const ask = window.nbdConfirm || ((m) => Promise.resolve(window.confirm(m)));
  if (!(await ask('Revoke all active portal links for this lead and mint a new one?\n\nThe old URL stops working immediately.'))) return;
  try {
    const mod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js');
    const fns = mod.getFunctions();
    const revoke = mod.httpsCallable(fns, 'revokePortalToken');
    const r = await revoke({ leadId });
    const n = (r && r.data && r.data.revoked) || 0;
    if (typeof showToast === 'function') showToast('Revoked ' + n + ' link(s). Minting a fresh one...', 'info');
    await window._sharePortalLink(leadId); // immediately issue a new one
  } catch (e) {
    console.error('revoke portal failed', e);
    if (typeof showToast === 'function') showToast('Revoke failed: ' + (e.message || 'unknown'), 'error');
  }
};

// ── Share Homeowner Portal Link ─────────────────────
// Mints a portal token via createPortalToken and produces the
// public URL. Copies to clipboard + opens SMS prefilled with the
// link + the homeowner's first name. Expires in 30 days.
// Mint-only portal URL for THIS page. Deliberately separate from
// PortalLinkHelpers.resolveUrl, which hard-throws unless window.CustomerPortal
// is present — and customer-portal.js is loaded on customer.html ONLY, never on
// either dashboard. Anything on the dashboard that needs a portal URL must come
// through here (the createPortalToken callable) or it dies at runtime.
// Side-effect free: no clipboard, no SMS, no share recording — the caller owns
// what happens next, and the caller owns calling PortalLinkHelpers.recordShare.
window._mintPortalUrl = async function (leadId) {
  if (!leadId) throw new Error('No lead selected');
  const mod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js');
  const fns = mod.getFunctions();
  const call = mod.httpsCallable(fns, 'createPortalToken');
  const res = await call({ leadId, ttlDays: 30 });
  const token = res && res.data && res.data.token;
  if (!token) throw new Error('No token returned');
  return location.origin + '/pro/portal.html?token=' + encodeURIComponent(token);
};

window._sharePortalLink = async function (leadId) {
  if (!leadId) { if (typeof showToast==='function') showToast('No lead selected','error'); return; }
  const lead = (window._leads || []).find(l => l.id === leadId);
  if (!lead) { if (typeof showToast==='function') showToast('Lead not found','error'); return; }
  try {
    const url = await window._mintPortalUrl(leadId);
    // Try clipboard first — falls back to prompt() if denied.
    try { await navigator.clipboard.writeText(url); } catch(e) {}
    if (typeof showToast==='function') showToast('Portal link copied to clipboard', 'success');
    // Offer SMS shortcut if phone on file.
    let usedChannel = 'copy';
    if (lead.phone) {
      const cleanPhone = String(lead.phone).replace(/\D/g, '');
      const first = lead.firstName || lead.fname || '';
      const body = encodeURIComponent(
        `Hi${first ? ' ' + first : ''}, here\'s your project page: ` + url +
        ` — you can see your estimate, sign the contract, or book an inspection time.`
      );
      window.open('sms:' + cleanPhone + '?body=' + body, '_self');
      usedChannel = 'sms';
    } else {
      // No phone — surface the URL so the rep can paste manually.
      window.prompt('Share this link with the homeowner:', url);
    }
    // Audit E: every share entry point must record so W44+ tracking
    // (badges, smart-followup, stale-shares filter, engagement score)
    // actually fires. PortalLinkHelpers patches in-memory cache for
    // instant kanban feedback AND queues the Firestore write.
    if (window.PortalLinkHelpers && typeof window.PortalLinkHelpers.recordShare === 'function') {
      window.PortalLinkHelpers.recordShare(leadId, usedChannel);
    }
  } catch (e) {
    console.error('share portal failed', e);
    if (typeof showToast==='function') showToast('Could not create portal link: ' + (e.message || 'error'), 'error');
  }
};
