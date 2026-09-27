/**
 * NBD Pro — Storm Center v1
 * Weather event → Revenue pipeline automation
 * NWS severe weather alerts → storm zones → canvassing plans
 * Integrates with D2D tracker, CRM leads, and territory maps
 */

(function() {
  'use strict';

  // ============================================================================
  // CONSTANTS
  // ============================================================================

  const NWS_ALERTS_API = 'https://api.weather.gov/alerts/active';
  const NWS_ZONES_API = 'https://api.weather.gov/zones';
  const NOMINATIM_REVERSE = 'https://nominatim.openstreetmap.org/reverse?format=json&';
  const NOMINATIM_SEARCH = 'https://nominatim.openstreetmap.org/search?format=json&limit=5&q=';

  // Storm types relevant to roofing
  const ROOFING_EVENTS = [
    'Tornado Warning', 'Tornado Watch',
    'Severe Thunderstorm Warning', 'Severe Thunderstorm Watch',
    'Hail', 'Wind',
    'Hurricane Warning', 'Hurricane Watch',
    'Tropical Storm Warning', 'Tropical Storm Watch',
    'High Wind Warning', 'Wind Advisory',
    'Flash Flood Warning', 'Flood Warning'
  ];

  // Severity scoring for prioritization
  const SEVERITY_SCORES = {
    'Extreme': 100,
    'Severe': 80,
    'Moderate': 50,
    'Minor': 25,
    'Unknown': 10
  };

  const CERTAINTY_MULTIPLIER = {
    'Observed': 1.0,
    'Likely': 0.9,
    'Possible': 0.6,
    'Unlikely': 0.3,
    'Unknown': 0.5
  };

  // Hail size → damage probability
  const HAIL_DAMAGE_PROB = {
    '< 1 inch': 0.15,
    '1 inch': 0.35,
    '1.5 inch': 0.60,
    '2 inch': 0.80,
    '2.5+ inch': 0.95
  };

  // Insurance carrier response patterns (avg days to schedule adjuster)
  const CARRIER_RESPONSE = {
    'State Farm': 5, 'Allstate': 7, 'USAA': 3, 'Liberty Mutual': 6,
    'Nationwide': 5, 'Progressive': 8, 'Farmers': 6, 'Erie': 4,
    'Travelers': 5, 'Hartford': 6, 'Cincinnati Financial': 4,
    'Auto-Owners': 5, 'Westfield': 4, 'Grange': 5, 'Safeco': 7, 'Other': 6
  };

  const PAGE_SIZE = 50;
  const STORM_STORAGE_KEY = 'nbd_storm_zones';
  const ALERT_CACHE_KEY = 'nbd_storm_alerts_cache';
  const ALERT_CACHE_TTL = 5 * 60 * 1000; // 5 min cache

  // ============================================================================
  // STATE
  // ============================================================================

  let alerts = [];
  let stormZones = [];
  let activeZone = null;
  let stormMap = null;
  let stormLayers = { alerts: null, zones: null, pins: null };
  let currentTab = 'alerts'; // 'alerts' | 'zones' | 'canvass' | 'analytics'
  let isLoading = false;
  let userLocation = null;
  let savedMapView = null;      // preserved center/zoom across render() map rebuilds
  let pendingZoneCenter = null; // focus the map on a just-opened zone after rebuild

  // ============================================================================
  // HELPERS
  // ============================================================================

  function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }
  function fmtDate(d) { if (!d) return '—'; const dt = new Date(d); if (isNaN(dt.getTime())) return '—'; return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  function timeAgo(d) {
    if (!d) return '';
    const t = new Date(d).getTime();
    if (isNaN(t)) return '';
    const diff = Date.now() - t;
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return mins + 'm ago';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    return Math.floor(hrs / 24) + 'd ago';
  }

  function severityColor(severity) {
    switch (severity) {
      case 'Extreme': return '#ff1744';
      case 'Severe': return '#ff6d00';
      case 'Moderate': return '#ffab00';
      case 'Minor': return '#4A9EFF';
      default: return 'var(--m)';
    }
  }

  function severityIcon(severity) {
    switch (severity) {
      case 'Extreme': return '🔴';
      case 'Severe': return '🟠';
      case 'Moderate': return '🟡';
      case 'Minor': return '🔵';
      default: return '⚪';
    }
  }

  function eventIcon(event) {
    if (/tornado/i.test(event)) return '🌪️';
    if (/hurricane|tropical/i.test(event)) return '🌀';
    if (/hail/i.test(event)) return '🧊';
    if (/thunder/i.test(event)) return '⛈️';
    if (/wind/i.test(event)) return '💨';
    if (/flood/i.test(event)) return '🌊';
    return '⚠️';
  }

  // ============================================================================
  // STORAGE
  // ============================================================================

  function loadStormZones() {
    try {
      const raw = localStorage.getItem(STORM_STORAGE_KEY);
      stormZones = raw ? JSON.parse(raw) : [];
    } catch (e) { stormZones = []; }
  }

  function saveStormZones() {
    try { localStorage.setItem(STORM_STORAGE_KEY, JSON.stringify(stormZones)); }
    catch (e) { console.error('Storm zones save error:', e); }
  }

  function getCachedAlerts() {
    try {
      const raw = localStorage.getItem(ALERT_CACHE_KEY);
      if (!raw) return null;
      const cached = JSON.parse(raw);
      if (Date.now() - cached.ts > ALERT_CACHE_TTL) return null;
      return cached.data;
    } catch (e) { return null; }
  }

  function cacheAlerts(data) {
    try { localStorage.setItem(ALERT_CACHE_KEY, JSON.stringify({ ts: Date.now(), data })); }
    catch (e) {}
  }

  // ============================================================================
  // NWS ALERT FETCHING
  // ============================================================================

  async function fetchAlerts(lat, lng, radius) {
    // Check cache first
    const cached = getCachedAlerts();
    if (cached) {
      alerts = cached;
      render(); // cache hit still needs a paint — init() rendered before alerts loaded
      return alerts;
    }

    isLoading = true;
    render();

    try {
      // NWS API: fetch alerts for a point or area
      let url = NWS_ALERTS_API + '?status=actual&message_type=alert';
      let haveLocalZone = false;

      // If we have coordinates, fetch by point
      if (lat && lng) {
        // Get NWS zone for this point
        const pointResp = await fetch(`https://api.weather.gov/points/${lat},${lng}`, {
          headers: { 'User-Agent': 'NBDProCRM/1.0 (roofing-crm)' }
        });
        if (pointResp.ok) {
          const pointData = await pointResp.json();
          const county = pointData.properties?.county;
          const forecastZone = pointData.properties?.forecastZone;
          if (county) {
            const zoneId = county.split('/').pop();
            url += '&zone=' + zoneId;
            haveLocalZone = true;
          }
        }
      }

      // Fall back to a STATE-WIDE query only if we couldn't localize to a county/
      // zone above. Previously this ran unconditionally and OVERWROTE the local
      // url, so every rep saw all statewide alerts (and huge polygons feeding the
      // roof/revenue estimates) instead of their own area.
      if (!haveLocalZone) {
        const stateCode = await getStateCode(lat, lng);
        if (stateCode) {
          url = NWS_ALERTS_API + '?status=actual&message_type=alert&area=' + stateCode;
        }
      }

      const resp = await fetch(url, {
        headers: { 'User-Agent': 'NBDProCRM/1.0 (roofing-crm)' }
      });

      if (!resp.ok) throw new Error('NWS API error: ' + resp.status);

      const data = await resp.json();
      const features = data.features || [];

      // Parse and score alerts
      alerts = features
        .map(f => parseAlert(f))
        .filter(a => a && isRoofingRelevant(a))
        .sort((a, b) => b.score - a.score);

      cacheAlerts(alerts);
    } catch (e) {
      console.error('Storm Center fetch error:', e);
      if (window.showToast) window.showToast('Could not fetch weather alerts', 'error');
    } finally {
      isLoading = false;
      render();
    }

    return alerts;
  }

  async function getStateCode(lat, lng) {
    if (!lat || !lng) {
      // Try to get from user profile or stored location
      const stored = localStorage.getItem('nbd_user_state');
      return stored || 'OH'; // default Ohio
    }
    try {
      const resp = await fetch(NOMINATIM_REVERSE + `lat=${lat}&lon=${lng}`);
      const data = await resp.json();
      const state = data.address?.state;
      // Convert full state name to 2-letter code
      const stateMap = {
        'Ohio': 'OH', 'Kentucky': 'KY', 'Indiana': 'IN', 'Michigan': 'MI',
        'Pennsylvania': 'PA', 'West Virginia': 'WV', 'Tennessee': 'TN',
        'Georgia': 'GA', 'Florida': 'FL', 'Texas': 'TX', 'Oklahoma': 'OK',
        'Kansas': 'KS', 'Nebraska': 'NE', 'Iowa': 'IA', 'Missouri': 'MO',
        'Illinois': 'IL', 'Wisconsin': 'WI', 'Minnesota': 'MN',
        'Colorado': 'CO', 'Alabama': 'AL', 'Mississippi': 'MS',
        'Louisiana': 'LA', 'Arkansas': 'AR', 'North Carolina': 'NC',
        'South Carolina': 'SC', 'Virginia': 'VA', 'Maryland': 'MD',
        'New York': 'NY', 'New Jersey': 'NJ', 'Connecticut': 'CT',
        'Massachusetts': 'MA'
      };
      const code = stateMap[state] || state?.substring(0, 2).toUpperCase();
      if (code) localStorage.setItem('nbd_user_state', code);
      return code;
    } catch (e) { return localStorage.getItem('nbd_user_state') || 'OH'; }
  }

  function parseAlert(feature) {
    const p = feature.properties;
    if (!p) return null;

    const severity = p.severity || 'Unknown';
    const certainty = p.certainty || 'Unknown';
    const score = (SEVERITY_SCORES[severity] || 10) * (CERTAINTY_MULTIPLIER[certainty] || 0.5);

    // Extract hail size from description if present
    let hailSize = null;
    const hailMatch = p.description?.match(/(\d+\.?\d*)\s*inch\s*hail/i);
    if (hailMatch) hailSize = parseFloat(hailMatch[1]);

    // Extract wind speed
    let windSpeed = null;
    const windMatch = p.description?.match(/(\d+)\s*mph\s*wind/i);
    if (windMatch) windSpeed = parseInt(windMatch[1]);

    // Get affected area coordinates
    const geometry = feature.geometry;
    let polygon = null;
    let center = null;
    if (geometry && geometry.type === 'Polygon' && geometry.coordinates) {
      polygon = geometry.coordinates[0].map(c => [c[1], c[0]]); // [lat, lng]
      const lats = polygon.map(p => p[0]);
      const lngs = polygon.map(p => p[1]);
      center = [
        (Math.min(...lats) + Math.max(...lats)) / 2,
        (Math.min(...lngs) + Math.max(...lngs)) / 2
      ];
    }

    return {
      id: p.id || feature.id,
      event: p.event,
      headline: p.headline,
      description: p.description,
      severity,
      certainty,
      urgency: p.urgency,
      score,
      hailSize,
      windSpeed,
      areaDesc: p.areaDesc,
      sent: p.sent,
      effective: p.effective,
      expires: p.expires,
      senderName: p.senderName,
      polygon,
      center,
      affectedZones: p.geocode?.UGC || [],
      damageProb: hailSize ? estimateDamageProb(hailSize, windSpeed) : (windSpeed > 70 ? 0.5 : 0.2)
    };
  }

  // Match on roofing-relevant KEYWORDS, not the first word of each event name.
  // The old `split(' ')[0]` matched "Severe Thunderstorm" on "severe" and "High
  // Wind" on "high", admitting non-roofing alerts (High Surf, Severe Weather
  // Statement, Heat) while pretending to use the ROOFING_EVENTS list.
  const ROOFING_KEYWORDS = ['tornado', 'thunderstorm', 'hail', 'wind', 'hurricane', 'tropical', 'flood'];
  function isRoofingRelevant(alert) {
    const ev = (alert.event || '').toLowerCase();
    return ROOFING_KEYWORDS.some(k => ev.includes(k));
  }

  function estimateDamageProb(hailSize, windSpeed) {
    let prob = 0.1;
    if (hailSize >= 2.5) prob = 0.95;
    else if (hailSize >= 2) prob = 0.80;
    else if (hailSize >= 1.5) prob = 0.60;
    else if (hailSize >= 1) prob = 0.35;
    else prob = 0.15;

    // Wind amplifier
    if (windSpeed) {
      if (windSpeed >= 80) prob = Math.min(prob + 0.2, 1.0);
      else if (windSpeed >= 60) prob = Math.min(prob + 0.1, 1.0);
    }
    return prob;
  }

  // ============================================================================
  // STORM ZONE MANAGEMENT
  // ============================================================================

  function createStormZone(alert) {
    const zone = {
      id: 'sz_' + Date.now(),
      alertId: alert.id,
      name: alert.event + ' — ' + (alert.areaDesc || 'Unknown Area').split(';')[0],
      event: alert.event,
      severity: alert.severity,
      score: alert.score,
      damageProb: alert.damageProb,
      hailSize: alert.hailSize,
      windSpeed: alert.windSpeed,
      polygon: alert.polygon,
      center: alert.center,
      areaDesc: alert.areaDesc,
      createdAt: new Date().toISOString(),
      alertExpires: alert.expires,
      status: 'active', // active | canvassing | completed
      knockCount: 0,
      leadCount: 0,
      estimatedRoofs: 0,
      assignedReps: [],
      canvassPlan: null,
      notes: ''
    };

    // Estimate roofs in area (rough: ~200 homes per sq mile in suburban areas).
    // Cap it — a large/state-wide NWS polygon would otherwise yield millions of
    // "roofs" and $billions of fake pipeline. A single canvassable storm zone is
    // realistically a few thousand homes at most.
    if (alert.polygon && alert.polygon.length > 2) {
      const areaSqMiles = calculatePolygonArea(alert.polygon);
      zone.estimatedRoofs = Math.min(Math.round(areaSqMiles * 200), 5000);
    }

    stormZones.unshift(zone);
    saveStormZones();
    if (window.showToast) window.showToast('Storm zone created: ' + zone.name, 'success');
    render();
    return zone;
  }

  // D2D "🌩️ Zone" button origin: build a storm zone directly from observed hail
  // the rep pulled on the D2D map (createStormTerritory), rather than from an NWS
  // alert (createZoneFromAlert). Registering it here — and returning the id so
  // D2D can stamp stormZoneId onto its territory — is what lets knocks logged
  // inside that territory attribute back via recordZoneKnock; without it a
  // rep-drawn zone never reaches Storm Center's per-zone analytics. Note these
  // zones (like all storm zones) are localStorage-only, so the counts are
  // per-device — self-consistent on the rep's phone, not a team rollup.
  //   params.ring          GeoJSON [lng,lat] outer ring (D2D order)
  //   params.bounds        { north, south, east, west }
  //   params.maxSizeInches, params.hits
  // Returns the new zone id, or null if the ring is unusable. Does not render()
  // (called from the D2D view; Storm re-reads localStorage on its next open).
  function registerHailZone(params) {
    params = params || {};
    const ring = Array.isArray(params.ring) ? params.ring : null;
    if (!ring || ring.length < 3) return null;
    const maxSize = Number(params.maxSizeInches) || 0;
    const hits = Number(params.hits) || 0;
    const b = params.bounds || null;
    // Storm Center zones store polygon as [lat,lng]; D2D's ring is [lng,lat].
    const polygon = ring.map(p => [p[1], p[0]]);
    // Observed hail already fell — no forecast uncertainty to discount — so score
    // straight off measured size, aligned with the D2D territory's own
    // CRITICAL-at-1.5" threshold so the two systems agree on priority.
    const score = maxSize >= 2 ? 100 : maxSize >= 1.5 ? 80 : maxSize >= 1.25 ? 65 : maxSize >= 1 ? 50 : 35;
    const center = b && isFinite(b.north) && isFinite(b.south) && isFinite(b.east) && isFinite(b.west)
      ? [(b.north + b.south) / 2, (b.east + b.west) / 2]
      : (polygon.length ? polygon[0].slice() : null);
    const zone = {
      id: 'sz_' + Date.now(),
      alertId: null,
      name: '🌩️ Storm ' + maxSize.toFixed(2) + '"',
      event: 'Observed Hail',
      severity: score >= 100 ? 'Extreme' : score >= 80 ? 'Severe' : score >= 50 ? 'Moderate' : 'Minor',
      score,
      damageProb: estimateDamageProb(maxSize, 0),
      hailSize: maxSize,
      windSpeed: null,
      polygon,
      center,
      areaDesc: hits + ' hail hit' + (hits !== 1 ? 's' : '') + ' up to ' + maxSize.toFixed(2) + '" (rep-mapped)',
      createdAt: new Date().toISOString(),
      alertExpires: null,
      status: 'canvassing', // rep is already working it in D2D
      knockCount: 0,
      leadCount: 0,
      estimatedRoofs: 0,
      assignedReps: [],
      canvassPlan: null,
      notes: '',
      source: 'd2d-rep' // ad-hoc rep zone — distinguish from vetted NWS-alert zones
    };
    if (polygon.length > 2) {
      const areaSqMiles = calculatePolygonArea(polygon);
      zone.estimatedRoofs = Math.min(Math.round(areaSqMiles * 200), 5000);
    }
    stormZones.unshift(zone);
    saveStormZones();
    return zone.id;
  }

  function calculatePolygonArea(coords) {
    // Shoelace formula with lat/lng → sq miles approximation
    if (!coords || coords.length < 3) return 0;
    let area = 0;
    for (let i = 0; i < coords.length; i++) {
      const j = (i + 1) % coords.length;
      area += coords[i][1] * coords[j][0];
      area -= coords[j][1] * coords[i][0];
    }
    area = Math.abs(area) / 2;
    // Convert degree² to sq miles (very rough: 1° lat ≈ 69mi, 1° lng ≈ 53mi at 39°N)
    return area * 69 * 53;
  }

  function deleteStormZone(zoneId) {
    stormZones = stormZones.filter(z => z.id !== zoneId);
    saveStormZones();
    render();
  }

  function confirmDeleteZone(zoneId) {
    const zone = stormZones.find(z => z.id === zoneId);
    const name = (zone && zone.name) || 'this storm zone';
    const body = 'This removes the zone and its canvass plan from this device.';
    // nbdModal.confirm renders strings via textContent (no escaping needed) and
    // works in iOS PWA standalone where native confirm() silently no-ops.
    if (window.nbdModal && typeof window.nbdModal.confirm === 'function') {
      window.nbdModal.confirm({ title: 'Delete ' + name + '?', body, okLabel: 'Delete', danger: true })
        .then(ok => { if (ok) deleteStormZone(zoneId); });
    } else if (window.confirm('Delete ' + name + '?\n' + body)) {
      deleteStormZone(zoneId);
    }
  }

  function updateStormZone(zoneId, updates) {
    const zone = stormZones.find(z => z.id === zoneId);
    if (zone) {
      Object.assign(zone, updates);
      saveStormZones();
    }
    return zone;
  }

  // D2D write-back: a knock (and optionally a converted lead) landed inside a
  // storm-zone-backed territory. The D2D tracker calls this after recording a
  // knock it attributed (point-in-polygon) to a zone's territory. Storm zones
  // are localStorage-only, so update there directly — robust whether or not the
  // Storm view is currently mounted (it re-reads localStorage on its next open).
  function recordZoneKnock(stormZoneId, isLead) {
    let zones;
    try { zones = JSON.parse(localStorage.getItem(STORM_STORAGE_KEY) || '[]'); }
    catch (_) { return false; }
    const z = Array.isArray(zones) ? zones.find(x => x && x.id === stormZoneId) : null;
    if (!z) return false;
    z.knockCount = (Number(z.knockCount) || 0) + 1;
    if (isLead) z.leadCount = (Number(z.leadCount) || 0) + 1;
    try { localStorage.setItem(STORM_STORAGE_KEY, JSON.stringify(zones)); } catch (_) { return false; }
    stormZones = zones; // keep the in-memory model in sync if Storm is loaded
    return true;
  }

  // ============================================================================
  // CANVASS PLAN GENERATION
  // ============================================================================

  function generateCanvassPlan(zone) {
    const plan = {
      zoneId: zone.id,
      generatedAt: new Date().toISOString(),
      priority: zone.score >= 80 ? 'CRITICAL' : zone.score >= 50 ? 'HIGH' : 'NORMAL',
      optimalWindow: calculateOptimalWindow(zone),
      talkingPoints: generateTalkingPoints(zone),
      carrierInsights: generateCarrierInsights(zone),
      estimatedRevenue: estimateZoneRevenue(zone),
      suggestedTeamSize: Math.max(1, Math.ceil(zone.estimatedRoofs / 100)),
      daysToComplete: Math.max(1, Math.ceil(zone.estimatedRoofs / 50)),
      steps: [
        { order: 1, action: 'Drive zone perimeter to assess visible damage', duration: '30-60 min' },
        { order: 2, action: 'Photograph damage examples (street level)', duration: '15-30 min' },
        { order: 3, action: 'Begin systematic door knocking (worst damage first)', duration: '3-4 hrs' },
        { order: 4, action: 'Follow up on "not home" doors (evening pass)', duration: '2-3 hrs' },
        { order: 5, action: 'Send follow-up texts to collected contacts', duration: '30 min' }
      ]
    };

    zone.canvassPlan = plan;
    saveStormZones();
    return plan;
  }

  function calculateOptimalWindow(zone) {
    // Best time to knock after a storm: 24-72 hours
    const expires = zone.alertExpires ? new Date(zone.alertExpires) : new Date();
    const start = new Date(expires.getTime() + 24 * 60 * 60 * 1000);
    const end = new Date(expires.getTime() + 72 * 60 * 60 * 1000);

    return {
      start: start.toISOString(),
      end: end.toISOString(),
      label: `${start.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} – ${end.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`,
      bestHours: '10am – 7pm (peak: 4-7pm)',
      note: zone.damageProb > 0.7 ? 'HIGH URGENCY — homeowners will be seeking help immediately' : 'Standard window — build rapport, offer free inspections'
    };
  }

  function generateTalkingPoints(zone) {
    const points = [];

    if (zone.hailSize) {
      points.push({
        type: 'opener',
        text: `Hi, I\'m with No Big Deal Home Solutions. We\'ve been working in the neighborhood after the ${zone.hailSize}"+ hail event. Have you had a chance to check your roof yet?`
      });
      points.push({
        type: 'damage',
        text: `Hail this size (${zone.hailSize}") causes damage to shingles that isn\'t always visible from the ground — granule loss, bruising, cracked tabs. Most insurance policies cover hail damage 100%.`
      });
    } else if (zone.windSpeed) {
      points.push({
        type: 'opener',
        text: `Hi, I\'m with No Big Deal Home Solutions. We\'re checking on homes in the area after those ${zone.windSpeed}mph winds. Have you noticed any shingles missing or loose?`
      });
      points.push({
        type: 'damage',
        text: `Wind speeds over 60mph can lift and crack shingles, especially along ridges and edges. Even if it looks okay from the ground, there could be hidden damage up top.`
      });
    } else {
      points.push({
        type: 'opener',
        text: `Hi, I\'m with No Big Deal Home Solutions. We\'re offering free storm damage inspections to homeowners in the area after the recent severe weather. Would you like us to take a look?`
      });
    }

    points.push({
      type: 'insurance',
      text: 'We document the damage with photos and give you a detailed repair estimate. You file and manage your claim, and once you have filed we can meet your adjuster. Your deductible is always yours to pay.'
    });
    points.push({
      type: 'close',
      text: 'We can do a free 15-minute inspection right now, or I can schedule a time that works better. Either way, it\'s good to know where you stand before the next storm hits.'
    });
    points.push({
      type: 'objection',
      text: 'I understand you want to think about it. Here\'s my card — but I\'d encourage you to file sooner rather than later. Most policies have a 1-year window from the date of damage to file a claim.'
    });

    return points;
  }

  function generateCarrierInsights(zone) {
    return Object.entries(CARRIER_RESPONSE).map(([carrier, days]) => ({
      carrier,
      avgResponseDays: days,
      recommendation: days <= 4 ? 'Fast adjuster — push for quick inspection' :
                      days <= 6 ? 'Standard timeline — set expectations' :
                      'Slow adjuster — offer to supplement'
    }));
  }

  function estimateZoneRevenue(zone) {
    const roofs = zone.estimatedRoofs || 50;
    const damageProb = zone.damageProb || 0.3;
    const closeRate = 0.15; // 15% of damaged roofs convert to jobs
    const avgJobValue = 12000; // average reroofing job

    const damagedRoofs = Math.round(roofs * damageProb);
    const expectedJobs = Math.round(damagedRoofs * closeRate);
    const revenue = expectedJobs * avgJobValue;

    return {
      estimatedRoofs: roofs,
      damagedRoofs,
      expectedJobs,
      revenue,
      revenueFormatted: '$' + revenue.toLocaleString()
    };
  }

  // ============================================================================
  // D2D INTEGRATION
  // ============================================================================

  function pushZoneToD2D(zone) {
    // Create a D2D territory from the storm zone so it actually renders on the
    // D2D map. D2D's renderSavedTerritories only draws docs with a `geoJSON`
    // Feature in [lng,lat] order — the old code wrote a `polygon` ([lat,lng])
    // field D2D skips, so the pushed zone was invisible. Mirror D2D's
    // saveTerritory shape (name/type/geoJSON/bounds). The write only needs
    // Firestore (set at boot), so it no longer gates on window.D2D being loaded.
    if (!zone.polygon || zone.polygon.length < 3) return null;

    const name = '🌩️ ' + zone.name;
    const ring = zone.polygon.map(p => [p[1], p[0]]); // [lat,lng] -> GeoJSON [lng,lat]
    const lats = zone.polygon.map(p => p[0]);
    const lngs = zone.polygon.map(p => p[1]);
    const territory = {
      name,
      type: 'polygon',
      geoJSON: { type: 'Feature', properties: { name }, geometry: { type: 'Polygon', coordinates: [ring] } },
      bounds: { north: Math.max(...lats), south: Math.min(...lats), east: Math.max(...lngs), west: Math.min(...lngs) },
      stormZoneId: zone.id,
      priority: zone.canvassPlan?.priority || 'NORMAL'
    };

    if (window._db && window._user) {
      const { addDoc, collection, serverTimestamp } = window;
      if (addDoc && collection) {
        addDoc(collection(window._db, 'territories'), Object.assign({}, territory, {
          userId: window._user.uid,
          companyId: window._userClaims?.companyId || window._user.uid,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        })).then(() => {
          if (window.showToast) window.showToast('Storm zone added to D2D as a territory', 'success');
        }).catch(e => console.error('Territory save error:', e));
      }
    }

    // Hint the D2D tracker to surface + zoom to this zone when it opens.
    try { localStorage.setItem('nbd_d2d_focus_bounds', JSON.stringify(territory.bounds)); } catch (_) {}

    return territory;
  }

  function createLeadsFromZone(zone) {
    // Navigate to the D2D tracker. The zone was already written as a territory
    // (pushZoneToD2D), which D2D now renders + zooms to via the focus hint;
    // activeZone is kept for any future in-app consumer.
    activeZone = zone;
    if (window.goTo) window.goTo('d2d');
  }

  // ============================================================================
  // GEOLOCATION
  // ============================================================================

  function getUserLocation() {
    return new Promise((resolve) => {
      if (userLocation) { resolve(userLocation); return; }

      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          pos => {
            userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
            resolve(userLocation);
          },
          () => {
            // Default to Cincinnati, OH
            userLocation = { lat: 39.1031, lng: -84.5120 };
            resolve(userLocation);
          },
          { timeout: 5000 }
        );
      } else {
        userLocation = { lat: 39.1031, lng: -84.5120 };
        resolve(userLocation);
      }
    });
  }

  // ============================================================================
  // MAP RENDERING
  // ============================================================================

  function initMap() {
    const container = document.getElementById('storm-map');
    if (!container || stormMap) return;

    if (typeof L === 'undefined') {
      setTimeout(initMap, 100);
      return;
    }

    const loc = userLocation || { lat: 39.1031, lng: -84.5120 };
    stormMap = L.map('storm-map', {
      center: [loc.lat, loc.lng],
      zoom: 8,
      zoomControl: false
    });

    L.control.zoom({ position: 'topright' }).addTo(stormMap);

    // Satellite tiles — Google primary (mt{s}.google.com, on the CSP img-src
    // allow-list); Esri/ArcGIS as a per-tile fallback. Esri alone is blocked
    // by Brave Shields at the network layer => gray void (NEW-D12 / PR #486).
    // Mirrors docs/pro/js/d2d-tracker-core-2026b.js initD2DMap.
    const stormSat = L.tileLayer('https://mt{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', {
      subdomains: '0123',
      attribution: 'Imagery © Google',
      maxNativeZoom: 22,
      maxZoom: 19
    });
    stormSat.on('tileerror', function (ev) {
      if (!ev.tile || !ev.coords || ev.tile.dataset.nbdFallbackTried === '1') return;
      ev.tile.dataset.nbdFallbackTried = '1';
      const c = ev.coords;
      ev.tile.src = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/'
        + c.z + '/' + c.y + '/' + c.x;
    });
    stormSat.addTo(stormMap);

    // Layer groups
    // Outlook sits UNDER everything else: it is a broad-area forecast, and an
    // active warning or a drawn zone must stay readable on top of it.
    stormLayers.outlook = L.layerGroup().addTo(stormMap);
    stormLayers.alerts = L.layerGroup().addTo(stormMap);
    stormLayers.zones = L.layerGroup().addTo(stormMap);
    stormLayers.pins = L.layerGroup().addTo(stormMap);

    // User location marker
    L.circleMarker([loc.lat, loc.lng], {
      radius: 8, color: '#4A9EFF', fillColor: '#4A9EFF', fillOpacity: 0.8, weight: 2
    }).addTo(stormMap).bindPopup('Your Location');

    renderMapLayers();

    // Restore the prior view (a tab switch rebuilds the map) or focus a zone the
    // user just opened — otherwise the map snaps back to the default every paint.
    if (pendingZoneCenter) {
      try { stormMap.setView(pendingZoneCenter, 11); } catch (_) {}
      pendingZoneCenter = null;
    } else if (savedMapView) {
      try { stormMap.setView(savedMapView.center, savedMapView.zoom); } catch (_) {}
    }
  }

  function renderMapLayers() {
    if (!stormMap) return;

    // Clear layers
    if (stormLayers.outlook) stormLayers.outlook.clearLayers();
    stormLayers.alerts.clearLayers();
    stormLayers.zones.clearLayers();

    // SPC Day-1 outlook, drawn from whatever StormOutlook already loaded.
    // Defensive: the module is a separate file in the storm bundle, and a
    // missing or failed outlook must never stop alerts from painting.
    if (stormLayers.outlook && window.StormOutlook && typeof window.StormOutlook.draw === 'function') {
      try { window.StormOutlook.draw(L, stormLayers.outlook); } catch (e) { console.warn('[StormCenter] outlook draw failed', e); }
    }

    // Draw alert polygons
    alerts.forEach(alert => {
      if (alert.polygon) {
        const color = severityColor(alert.severity);
        const poly = L.polygon(alert.polygon, {
          color,
          fillColor: color,
          fillOpacity: 0.15,
          weight: 2,
          dashArray: '5,5'
        }).addTo(stormLayers.alerts);

        poly.bindPopup(`
          <div style="font-family:'Barlow',sans-serif;max-width:250px;">
            <div style="font-weight:700;font-size:13px;">${eventIcon(alert.event)} ${esc(alert.event)}</div>
            <div style="font-size:11px;color:#666;margin-top:4px;">${esc(alert.areaDesc?.split(';')[0] || '')}</div>
            ${alert.hailSize ? `<div style="margin-top:4px;font-size:12px;">🧊 ${alert.hailSize}" hail</div>` : ''}
            ${alert.windSpeed ? `<div style="margin-top:2px;font-size:12px;">💨 ${alert.windSpeed} mph</div>` : ''}
            <div style="margin-top:6px;font-size:11px;">Damage probability: <strong>${Math.round(alert.damageProb * 100)}%</strong></div>
            <button class="btn btn-orange btn-sm" data-storm-action="createZone" data-storm-id="${alert.id}" style="margin-top:8px;">Create Storm Zone</button>
          </div>
        `);
      }
    });

    // Draw storm zones
    stormZones.forEach(zone => {
      if (zone.polygon) {
        const color = zone.status === 'completed' ? '#2ECC8A' :
                      zone.status === 'canvassing' ? '#BD5728' : '#ff6d00';
        const poly = L.polygon(zone.polygon, {
          color,
          fillColor: color,
          fillOpacity: 0.25,
          weight: 3
        }).addTo(stormLayers.zones);

        poly.bindPopup(`
          <div style="font-family:'Barlow',sans-serif;max-width:250px;">
            <div style="font-weight:700;font-size:13px;">🌩️ ${esc(zone.name)}</div>
            <div style="font-size:11px;margin-top:4px;">Status: <strong>${esc(String(zone.status || 'active')).toUpperCase()}</strong></div>
            <div style="font-size:11px;">Est. roofs: ${zone.estimatedRoofs} · ${Math.round((zone.damageProb || 0) * 100)}% damage</div>
            <div style="margin-top:6px;display:flex;gap:6px;">
              <button class="btn btn-ghost btn-sm" data-storm-action="openZone" data-storm-id="${zone.id}">View</button>
              <button class="btn btn-orange btn-sm" data-storm-action="pushToD2D" data-storm-id="${zone.id}">Start Knocking</button>
            </div>
          </div>
        `);
      }
    });
  }

  // ============================================================================
  // UI RENDERING
  // ============================================================================

  function setTab(tab) {
    currentTab = tab;
    render();
  }

  function render() {
    const container = document.getElementById('view-storm');
    if (!container) return;

    const scroll = container.querySelector('.view-scroll') || container;

    // Design-system underline tabs (.stab-btn — same vocabulary as Settings),
    // replacing the ad-hoc pill buttons (2026-07-19 CRM visual audit batch 2).
    const tabBtn = (id, label, icon) =>
      `<button class="stab-btn${currentTab === id ? ' stab-active' : ''}" data-storm-action="setTab" data-storm-id="${id}">${icon} ${label}</button>`;

    // Stats bar
    const activeAlerts = alerts.length;
    const activeZones = stormZones.filter(z => z.status !== 'completed').length;
    // Sum revenue for ALL zones (matching the per-zone + Analytics displays);
    // the old plan-gated sum made the header undercount vs the cards below it.
    const totalRevenue = stormZones.reduce((s, z) => s + estimateZoneRevenue(z).revenue, 0);

    let html = `
      <div style="padding:16px 20px 0;">
        <!-- Header -->
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
          <div>
            <div style="font-size:22px;font-weight:800;font-family:'Barlow Condensed',sans-serif;color:var(--t);letter-spacing:.02em;">⛈️ STORM CENTER</div>
            <div style="font-size:12px;color:var(--m);margin-top:2px;">Weather intelligence → Revenue pipeline</div>
          </div>
          <button class="btn btn-orange" data-storm-action="refresh">
            ${isLoading ? '⏳ Loading...' : '🔄 Refresh Alerts'}
          </button>
        </div>

        <!-- Stats Strip (.stat-card design-system tiles) -->
        <div style="display:flex;gap:10px;margin-bottom:14px;overflow-x:auto;">
          <div class="stat-card" style="flex:1;min-width:120px;">
            <div class="stat-icon">📡</div>
            <div><div class="stat-val" style="color:${activeAlerts > 0 ? '#ff6d00' : 'var(--t)'};font-size:22px;">${activeAlerts}</div><div class="stat-lbl">Active Alerts</div></div>
          </div>
          <div class="stat-card" style="flex:1;min-width:120px;">
            <div class="stat-icon">🗺️</div>
            <div><div class="stat-val" style="color:var(--blue);font-size:22px;">${activeZones}</div><div class="stat-lbl">Storm Zones</div></div>
          </div>
          <div class="stat-card" style="flex:1;min-width:120px;">
            <div class="stat-icon">💰</div>
            <div><div class="stat-val" style="color:var(--green);font-size:22px;">$${Math.round(totalRevenue/1000)}k</div><div class="stat-lbl">Pipeline Value</div></div>
          </div>
          ${(() => {
            // SPC Day-1 outlook at the rep's own location. Renders NOTHING when
            // the point is outside every polygon — a quiet day must read as
            // absence, not as a zero risk score.
            try {
              const o = (window.StormOutlook && userLocation)
                ? window.StormOutlook.summarizeAt(userLocation.lat, userLocation.lng) : null;
              if (!o || !o.text) return '';
              return `<div class="stat-card" style="flex:1;min-width:150px;">
            <div class="stat-icon">⛈️</div>
            <div><div class="stat-val" style="color:${o.color || 'var(--t)'};font-size:15px;line-height:1.25;">${esc(o.text)}</div><div class="stat-lbl">SPC Outlook Today</div></div>
          </div>`;
            } catch (e) { return ''; }
          })()}
          <div class="stat-card" style="flex:1;min-width:120px;">
            <div class="stat-icon">🚪</div>
            <div><div class="stat-val" style="color:var(--orange);font-size:22px;">${stormZones.reduce((s, z) => s + (Number(z.knockCount) || 0), 0)}</div><div class="stat-lbl">Storm Knocks</div></div>
          </div>
        </div>

        <!-- Tabs (.stab-btn underline vocabulary) -->
        <div style="display:flex;gap:0;margin-bottom:14px;overflow-x:auto;border-bottom:2px solid var(--br);">
          ${tabBtn('alerts', 'Live Alerts', '📡')}
          ${tabBtn('zones', 'Storm Zones', '🗺️')}
          ${tabBtn('canvass', 'Canvass Plans', '🚪')}
          ${tabBtn('analytics', 'Storm Analytics', '📊')}
        </div>
      </div>

      <!-- Map -->
      <div id="storm-map" style="width:100%;height:280px;border-top:1px solid var(--br);border-bottom:1px solid var(--br);"></div>

      <div style="padding:0 20px 20px;">
    `;

    // Tab content
    if (currentTab === 'alerts') {
      html += renderAlertsTab();
    } else if (currentTab === 'zones') {
      html += renderZonesTab();
    } else if (currentTab === 'canvass') {
      html += renderCanvassTab();
    } else if (currentTab === 'analytics') {
      html += renderAnalyticsTab();
    }

    html += '</div>';

    scroll.innerHTML = html;

    // Delegated click handler — restores all previously-inline onclick
    // dispatchers (setTab/refresh/createZone/openZone/pushToD2D/generatePlan)
    // under the prod CSP `script-src-attr 'none'`, which silently blocks
    // onclick= attributes whether static or injected via innerHTML.
    scroll.onclick = function (ev) {
      const target = ev.target.closest('[data-storm-action]');
      if (!target) return;
      const action = target.dataset.stormAction;
      const id = target.dataset.stormId;
      if (target.dataset.stormStop === '1') ev.stopPropagation();
      const fn = window.StormCenter && window.StormCenter[action];
      if (typeof fn === 'function') {
        try { id ? fn(id) : fn(); }
        catch (e) { console.error('[storm-center] dispatch failed for ' + action + ':', e); }
      } else {
        console.warn('[storm-center] unknown action:', action);
      }
    };

    // Re-init the map after the DOM update. Capture the prior view and tear down
    // the old Leaflet instance (its #storm-map node was just replaced by the
    // innerHTML above) so its listeners don't leak and zoom/pan survives the
    // repaint instead of snapping back to default on every tab switch.
    if (stormMap) {
      try { savedMapView = { center: stormMap.getCenter(), zoom: stormMap.getZoom() }; } catch (_) {}
      try { stormMap.remove(); } catch (_) {}
    }
    stormMap = null;
    setTimeout(initMap, 50);
  }

  function renderAlertsTab() {
    if (isLoading) {
      return '<div class="nbd-empty"><div class="ne-sub">⏳ Fetching NWS alerts...</div></div>';
    }

    if (alerts.length === 0) {
      return `
        <div class="nbd-empty">
          <div class="ne-icon">☀️</div>
          <div class="ne-msg">No Active Alerts</div>
          <div class="ne-sub">All clear in your area. Click Refresh to check again.</div>
        </div>
      `;
    }

    return `
      <div style="margin-top:14px;">
        <div style="font-size:13px;font-weight:700;color:var(--t);margin-bottom:10px;font-family:'Barlow Condensed',sans-serif;text-transform:uppercase;letter-spacing:.06em;">
          ${alerts.length} Active Alert${alerts.length !== 1 ? 's' : ''}
        </div>
        ${alerts.map(a => `
          <div style="background:var(--s2);border:1px solid var(--br);border-radius:10px;padding:14px;margin-bottom:10px;border-left:4px solid ${severityColor(a.severity)};">
            <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;">
              <div style="flex:1;">
                <div style="font-size:14px;font-weight:700;color:var(--t);">
                  ${eventIcon(a.event)} ${esc(a.event)}
                </div>
                <div style="font-size:11px;color:var(--m);margin-top:3px;">${esc(a.areaDesc?.split(';').slice(0, 3).join(', ') || 'Unknown area')}</div>
                <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">
                  <span style="font-size:10px;padding:2px 8px;border-radius:10px;background:color-mix(in srgb, ${severityColor(a.severity)} 13%, transparent);color:${severityColor(a.severity)};font-weight:600;">${a.severity}</span>
                  ${a.hailSize ? `<span style="font-size:10px;padding:2px 8px;border-radius:10px;background:color-mix(in srgb, var(--blue) 13%, transparent);color:var(--blue);font-weight:600;">🧊 ${a.hailSize}" Hail</span>` : ''}
                  ${a.windSpeed ? `<span style="font-size:10px;padding:2px 8px;border-radius:10px;background:color-mix(in srgb, #ff6d00 13%, transparent);color:#ff6d00;font-weight:600;">💨 ${a.windSpeed}mph</span>` : ''}
                  <span style="font-size:10px;padding:2px 8px;border-radius:10px;background:color-mix(in srgb, ${a.damageProb > 0.6 ? '#ff1744' : '#ffab00'} 13%, transparent);color:${a.damageProb > 0.6 ? '#ff1744' : '#ffab00'};font-weight:600;">
                    ${Math.round(a.damageProb * 100)}% damage prob
                  </span>
                </div>
              </div>
              <div style="text-align:right;flex-shrink:0;">
                <div style="font-size:10px;color:var(--m);">${timeAgo(a.sent)}</div>
                <div style="font-size:10px;color:var(--m);margin-top:2px;">Expires ${fmtDate(a.expires)}</div>
                <button class="btn btn-orange btn-sm" data-storm-action="createZone" data-storm-id="${a.id}" style="margin-top:8px;">
                  Create Zone
                </button>
              </div>
            </div>
          </div>
        `).join('')}
      </div>
    `;
  }

  function renderZonesTab() {
    if (stormZones.length === 0) {
      return `
        <div class="nbd-empty">
          <div class="ne-icon">🗺️</div>
          <div class="ne-msg">No Storm Zones Yet</div>
          <div class="ne-sub">Create zones from active alerts to start building canvass plans.</div>
        </div>
      `;
    }

    return `
      <div style="margin-top:14px;">
        ${stormZones.map(z => {
          const rev = estimateZoneRevenue(z);
          return `
            <div style="background:var(--s2);border:1px solid var(--br);border-radius:10px;padding:14px;margin-bottom:10px;cursor:pointer;" data-storm-action="openZone" data-storm-id="${z.id}">
              <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;">
                <div>
                  <div style="font-size:14px;font-weight:700;color:var(--t);">🌩️ ${esc(z.name)}</div>
                  <div style="font-size:11px;color:var(--m);margin-top:3px;">Created ${timeAgo(z.createdAt)}</div>
                  <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;">
                    <span style="font-size:10px;padding:2px 8px;border-radius:10px;background:color-mix(in srgb, ${z.status === 'active' ? '#ff6d00' : z.status === 'canvassing' ? 'var(--orange)' : 'var(--green)'} 13%, transparent);color:${z.status === 'active' ? '#ff6d00' : z.status === 'canvassing' ? 'var(--orange)' : 'var(--green)'};font-weight:600;text-transform:uppercase;">${esc(z.status)}</span>
                    <span style="font-size:10px;padding:2px 8px;border-radius:10px;background:var(--s);border:1px solid var(--br);color:var(--t);">🏠 ${z.estimatedRoofs} roofs</span>
                    <span style="font-size:10px;padding:2px 8px;border-radius:10px;background:var(--s);border:1px solid var(--br);color:var(--t);">🚪 ${Number(z.knockCount) || 0} knocks</span>
                    <span style="font-size:10px;padding:2px 8px;border-radius:10px;background:color-mix(in srgb, var(--green) 13%, transparent);color:var(--green);font-weight:600;">${rev.revenueFormatted} pipeline</span>
                  </div>
                </div>
                <div style="display:flex;flex-direction:column;gap:4px;flex-shrink:0;">
                  <button class="btn btn-ghost btn-sm" data-storm-action="generatePlan" data-storm-id="${z.id}" data-storm-stop="1">📋 Plan</button>
                  <button class="btn btn-orange btn-sm" data-storm-action="pushToD2D" data-storm-id="${z.id}" data-storm-stop="1">🚪 Knock</button>
                  <button class="btn btn-ghost btn-sm" data-storm-action="attachProof" data-storm-id="${z.id}" data-storm-stop="1" title="Stamp verified storm evidence onto every lead in this zone for adjuster back-checks">🛡️ Proof</button>
                  <button class="btn btn-red btn-sm" data-storm-action="remove" data-storm-id="${z.id}" data-storm-stop="1">🗑 Delete</button>
                </div>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  function renderCanvassTab() {
    const zonesWithPlans = stormZones.filter(z => z.canvassPlan);
    if (zonesWithPlans.length === 0) {
      return `
        <div class="nbd-empty">
          <div class="ne-icon">📋</div>
          <div class="ne-msg">No Canvass Plans Yet</div>
          <div class="ne-sub">Generate a plan from any storm zone to get step-by-step canvassing instructions.</div>
        </div>
      `;
    }

    return zonesWithPlans.map(z => {
      const plan = z.canvassPlan;
      const rev = estimateZoneRevenue(z);
      return `
        <div style="background:var(--s2);border:1px solid var(--br);border-radius:10px;padding:16px;margin-top:14px;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
            <div style="font-size:15px;font-weight:700;color:var(--t);">📋 ${esc(z.name)}</div>
            <span style="font-size:10px;padding:3px 10px;border-radius:10px;background:color-mix(in srgb, ${plan.priority === 'CRITICAL' ? '#ff1744' : plan.priority === 'HIGH' ? '#ff6d00' : 'var(--blue)'} 13%, transparent);color:${plan.priority === 'CRITICAL' ? '#ff1744' : plan.priority === 'HIGH' ? '#ff6d00' : 'var(--blue)'};font-weight:700;">${plan.priority} PRIORITY</span>
          </div>

          <!-- Optimal Window -->
          <div style="background:var(--s);border:1px solid var(--br);border-radius:8px;padding:12px;margin-bottom:10px;">
            <div style="font-size:11px;font-weight:700;color:var(--orange);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px;">⏰ Optimal Canvassing Window</div>
            <div style="font-size:14px;font-weight:600;color:var(--t);">${plan.optimalWindow.label}</div>
            <div style="font-size:11px;color:var(--m);margin-top:2px;">${plan.optimalWindow.bestHours}</div>
            <div style="font-size:11px;color:var(--green);margin-top:2px;">${plan.optimalWindow.note}</div>
          </div>

          <!-- Revenue Projection (.stat-card tiles) -->
          <div style="display:flex;gap:8px;margin-bottom:10px;">
            <div class="stat-card" style="flex:1;padding:10px 12px;">
              <div><div class="stat-val" style="font-size:18px;">${rev.estimatedRoofs}</div><div class="stat-lbl">Est. Roofs</div></div>
            </div>
            <div class="stat-card" style="flex:1;padding:10px 12px;">
              <div><div class="stat-val" style="font-size:18px;color:var(--orange);">${rev.damagedRoofs}</div><div class="stat-lbl">Likely Damaged</div></div>
            </div>
            <div class="stat-card" style="flex:1;padding:10px 12px;">
              <div><div class="stat-val" style="font-size:18px;color:var(--green);">${rev.expectedJobs}</div><div class="stat-lbl">Expected Jobs</div></div>
            </div>
            <div class="stat-card" style="flex:1;padding:10px 12px;">
              <div><div class="stat-val" style="font-size:18px;color:var(--green);">${rev.revenueFormatted}</div><div class="stat-lbl">Revenue</div></div>
            </div>
          </div>

          <!-- Action Steps -->
          <div style="font-size:11px;font-weight:700;color:var(--t);text-transform:uppercase;letter-spacing:.06em;margin:12px 0 8px;">📋 Action Plan</div>
          ${plan.steps.map(s => `
            <div style="display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-bottom:1px solid var(--br);">
              <div style="width:22px;height:22px;border-radius:50%;background:var(--orange);color:white;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0;">${s.order}</div>
              <div style="flex:1;">
                <div style="font-size:12px;color:var(--t);">${esc(s.action)}</div>
                <div style="font-size:10px;color:var(--m);margin-top:2px;">${s.duration}</div>
              </div>
            </div>
          `).join('')}

          <!-- Talking Points -->
          <div style="font-size:11px;font-weight:700;color:var(--t);text-transform:uppercase;letter-spacing:.06em;margin:14px 0 8px;">💬 Talking Points</div>
          ${plan.talkingPoints.map(tp => `
            <div style="background:var(--s);border:1px solid var(--br);border-radius:8px;padding:10px;margin-bottom:6px;">
              <div style="font-size:9px;font-weight:700;color:var(--orange);text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px;">${tp.type}</div>
              <div style="font-size:12px;color:var(--t);line-height:1.4;">"${esc(tp.text)}"</div>
            </div>
          `).join('')}

          <!-- Team -->
          <div style="display:flex;gap:10px;margin-top:12px;padding-top:10px;border-top:1px solid var(--br);">
            <div style="font-size:11px;color:var(--m);">👥 Suggested team: <strong style="color:var(--t);">${plan.suggestedTeamSize} rep${plan.suggestedTeamSize > 1 ? 's' : ''}</strong></div>
            <div style="font-size:11px;color:var(--m);">📅 Est. completion: <strong style="color:var(--t);">${plan.daysToComplete} day${plan.daysToComplete > 1 ? 's' : ''}</strong></div>
          </div>

          <button class="btn btn-orange" data-storm-action="pushToD2D" data-storm-id="${z.id}" style="width:100%;justify-content:center;margin-top:12px;padding:12px;">
            🚪 Start Knocking This Zone
          </button>
        </div>
      `;
    }).join('');
  }

  function renderAnalyticsTab() {
    // Live now: D2D attributes each knock to the containing storm zone's territory
    // (submitKnock → StormCenter.recordKnock), so these reflect real canvassing.
    const totalKnocks = stormZones.reduce((s, z) => s + (Number(z.knockCount) || 0), 0);
    const totalLeads = stormZones.reduce((s, z) => s + (Number(z.leadCount) || 0), 0);
    const convRate = totalKnocks > 0 ? Math.round(totalLeads / totalKnocks * 100) : 0;

    return `
      <div style="margin-top:14px;">
        <div style="font-size:13px;font-weight:700;color:var(--t);margin-bottom:10px;font-family:'Barlow Condensed',sans-serif;text-transform:uppercase;letter-spacing:.06em;">📊 Storm Performance</div>

        <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:16px;">
          <div class="stat-card">
            <div class="stat-icon">🗺️</div>
            <div><div class="stat-val">${stormZones.length}</div><div class="stat-lbl">Total Zones</div></div>
          </div>
          <div class="stat-card">
            <div class="stat-icon">🚪</div>
            <div><div class="stat-val" style="color:var(--orange);">${totalKnocks}</div><div class="stat-lbl">Storm Knocks</div></div>
          </div>
          <div class="stat-card">
            <div class="stat-icon">👥</div>
            <div><div class="stat-val" style="color:var(--blue);">${totalLeads}</div><div class="stat-lbl">Leads Generated</div></div>
          </div>
          <div class="stat-card">
            <div class="stat-icon">📈</div>
            <div><div class="stat-val" style="color:var(--green);">${convRate}%</div><div class="stat-lbl">Conversion Rate</div></div>
          </div>
        </div>

        <!-- Zone History -->
        <div style="font-size:11px;font-weight:700;color:var(--t);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px;">Zone History</div>
        ${stormZones.length === 0 ? '<div class="nbd-empty" style="padding:20px;"><div class="ne-sub">No zone history yet</div></div>' :
          stormZones.map(z => {
            const rev = estimateZoneRevenue(z);
            return `
              <div style="display:flex;align-items:center;gap:10px;padding:10px;border-bottom:1px solid var(--br);">
                <div style="font-size:18px;">${eventIcon(z.event)}</div>
                <div style="flex:1;">
                  <div style="font-size:12px;font-weight:600;color:var(--t);">${esc(z.name.substring(0, 40))}</div>
                  <div style="font-size:10px;color:var(--m);">${timeAgo(z.createdAt)} · ${Number(z.knockCount) || 0} knocks · ${Number(z.leadCount) || 0} leads</div>
                </div>
                <div style="font-size:12px;font-weight:700;color:var(--green);">${rev.revenueFormatted}</div>
              </div>
            `;
          }).join('')
        }

        <!-- Carrier Performance -->
        <div style="font-size:11px;font-weight:700;color:var(--t);text-transform:uppercase;letter-spacing:.06em;margin:16px 0 8px;">🏢 Carrier Response Times</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:6px;">
          ${Object.entries(CARRIER_RESPONSE).filter(([c]) => c !== 'Other').map(([carrier, days]) => `
            <div style="background:var(--s2);border:1px solid var(--br);border-radius:8px;padding:8px 10px;display:flex;align-items:center;justify-content:space-between;">
              <span style="font-size:11px;color:var(--t);">${esc(carrier)}</span>
              <span style="font-size:11px;font-weight:700;color:${days <= 4 ? 'var(--green)' : days <= 6 ? 'var(--orange)' : 'var(--red)'};">${days}d</span>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  // ============================================================================
  // INIT & PUBLIC API
  // ============================================================================

  async function init() {
    loadStormZones();
    render();

    // Get user location and fetch alerts
    const loc = await getUserLocation();
    // The SPC outlook is independent of the alert fetch and must not delay it
    // or fail it — kick it off in parallel and repaint when it lands.
    const outlook = (window.StormOutlook && typeof window.StormOutlook.load === 'function')
      ? window.StormOutlook.load().then(() => { try { renderMapLayers(); render(); } catch (e) {} }).catch(() => {})
      : Promise.resolve();
    await fetchAlerts(loc.lat, loc.lng);
    await outlook;
  }

  async function refresh() {
    // Clear cache and re-fetch
    localStorage.removeItem(ALERT_CACHE_KEY);
    const loc = await getUserLocation();
    await fetchAlerts(loc.lat, loc.lng);
  }

  function createZoneFromAlert(alertId) {
    const alert = alerts.find(a => a.id === alertId);
    if (alert) createStormZone(alert);
  }

  function openZoneDetail(zoneId) {
    activeZone = stormZones.find(z => z.id === zoneId);
    if (activeZone) {
      currentTab = 'zones';
      // Stage the center BEFORE render() — the old code called setView after
      // render() had already nulled stormMap (rebuilt async), so it was a no-op.
      if (activeZone.center) pendingZoneCenter = activeZone.center;
      render();
    }
  }

  function generatePlanForZone(zoneId) {
    const zone = stormZones.find(z => z.id === zoneId);
    if (zone) {
      generateCanvassPlan(zone);
      currentTab = 'canvass';
      render();
    }
  }

  function pushZoneToD2DById(zoneId) {
    const zone = stormZones.find(z => z.id === zoneId);
    if (zone) {
      zone.status = 'canvassing';
      saveStormZones();
      pushZoneToD2D(zone);
      createLeadsFromZone(zone);
    }
  }

  // Bulk-attach verified storm evidence to every lead inside a zone. Wires the
  // already-written StormIntegration.attachStormProofToZone (which had zero
  // callers) — the single highest-value insurance-claim lever in the app. Each
  // lead gets a stormEvents[] entry + a 'storm_proof' timeline note a rep can
  // cite when an adjuster claims "there wasn't a storm that day". Zones and
  // lead-matching are local (findLeadsInZone reads window._leads), so this
  // works without any server round-trip. Honest framing: NWS reports are area
  // reports near the zone, not per-parcel certainty.
  function attachProofForZone(zoneId) {
    const zone = stormZones.find(z => z.id === zoneId);
    if (!zone) return;
    const SI = window.StormIntegration;
    if (!SI || typeof SI.attachStormProofToZone !== 'function') {
      if (window.showToast) window.showToast('Storm-proof engine not loaded', 'error');
      return;
    }
    const affected = (typeof SI.findLeadsInZone === 'function') ? (SI.findLeadsInZone(zone) || []) : [];
    if (!affected.length) {
      if (window.showToast) window.showToast('No leads fall inside this storm zone yet', 'info');
      return;
    }
    const name = zone.name || 'this storm zone';
    const body = 'Stamps verified storm evidence onto ' + affected.length + ' lead' +
      (affected.length !== 1 ? 's' : '') + ' inside "' + name + '" for adjuster back-checks.';
    const run = async () => {
      if (window.showToast) window.showToast('Attaching storm proof to ' + affected.length + ' lead' + (affected.length !== 1 ? 's' : '') + '…', 'info');
      try {
        const res = await SI.attachStormProofToZone(zone);
        const n = (res && res.attached) ? res.attached.length : 0;
        const f = (res && res.failed) ? res.failed.length : 0;
        if (window.showToast) window.showToast('🛡️ Storm proof attached to ' + n + ' lead' + (n !== 1 ? 's' : '') + (f ? ' (' + f + ' failed)' : ''), n ? 'success' : 'error');
      } catch (e) {
        console.error('[storm-center] attachProof failed:', e);
        if (window.showToast) window.showToast('Could not attach storm proof', 'error');
      }
    };
    // Mirror confirmDeleteZone: nbdModal in iOS PWA (native confirm no-ops there).
    if (window.nbdModal && typeof window.nbdModal.confirm === 'function') {
      window.nbdModal.confirm({ title: 'Attach storm proof?', body, okLabel: 'Attach proof' })
        .then(ok => { if (ok) run(); });
    } else if (window.confirm(body)) {
      run();
    }
  }

  // Public API
  window.StormCenter = {
    init,
    render,
    refresh,
    setTab,
    createZone: createZoneFromAlert,
    registerHailZone: registerHailZone,
    openZone: openZoneDetail,
    generatePlan: generatePlanForZone,
    pushToD2D: pushZoneToD2DById,
    attachProof: attachProofForZone,
    deleteZone: deleteStormZone,
    remove: confirmDeleteZone,
    updateZone: updateStormZone,
    recordKnock: recordZoneKnock,
    getAlerts: () => alerts,
    getZones: () => stormZones,
    getActiveZone: () => activeZone
  };

})();
