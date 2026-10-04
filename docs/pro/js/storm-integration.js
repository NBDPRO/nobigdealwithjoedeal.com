// ============================================================
// NBD Pro — Storm Integration Layer
//
// Bridges the existing StormCenter module to the rest of the
// platform:
//
//   1. CRM cross-reference — find existing leads inside storm
//      polygons so Joe can prioritize follow-ups
//   2. Historical proof attachment — store the storm event on
//      each affected customer record as adjuster back-check
//      evidence ("there WAS a hail event at this address on
//      date X with peak hail Y")
//   3. Marketing triggers — generate suggested door-hanger,
//      postcard, and social media content per storm event
//   4. Heat map data — points/intensity for the D2D map overlay
//   5. Ask Joe proactive alert — fires an alert into the
//      notification queue when a new high-priority storm is
//      detected in the service area
//
// Exposes window.StormIntegration. Depends on:
//   - window.StormCenter  (existing module)
//   - window.D2D          (for territory push)
//   - window._db / _user  (Firestore)
//   - window._leads       (CRM lead cache)
// ============================================================

(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  // ═════════════════════════════════════════════════════════
  // Geo helpers — point-in-polygon, bounds check
  // ═════════════════════════════════════════════════════════

  /**
   * Ray-casting point-in-polygon algorithm.
   * polygon = [[lat,lng], [lat,lng], ...]
   */
  function pointInPolygon(point, polygon) {
    if (!polygon || polygon.length < 3) return false;
    const [y, x] = point;
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const [yi, xi] = polygon[i];
      const [yj, xj] = polygon[j];
      const intersect = ((xi > x) !== (xj > x)) &&
                        (y < (yj - yi) * (x - xi) / (xj - xi + 1e-12) + yi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  /**
   * Haversine distance in miles between two lat/lng points.
   */
  function distanceMiles(a, b) {
    const toRad = (d) => d * Math.PI / 180;
    const R = 3958.8;
    const dLat = toRad(b[0] - a[0]);
    const dLng = toRad(b[1] - a[1]);
    const lat1 = toRad(a[0]);
    const lat2 = toRad(b[0]);
    const x = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }

  // ═════════════════════════════════════════════════════════
  // 1. CRM cross-reference — which leads are in the storm?
  // ═════════════════════════════════════════════════════════

  /**
   * Find all CRM leads that fall within a storm zone's polygon.
   * Returns array of leads with a `distanceFromCenter` field.
   */
  function findLeadsInZone(zone, leads) {
    if (!zone) return [];
    leads = leads || window._leads || [];
    const polygon = zone.polygon || (zone.bounds && [
      [zone.bounds.n, zone.bounds.w],
      [zone.bounds.n, zone.bounds.e],
      [zone.bounds.s, zone.bounds.e],
      [zone.bounds.s, zone.bounds.w]
    ]);
    const center = zone.center || (polygon && polygon.length
      ? [
          polygon.reduce((s, p) => s + p[0], 0) / polygon.length,
          polygon.reduce((s, p) => s + p[1], 0) / polygon.length
        ]
      : null);

    const inside = [];
    leads.forEach(lead => {
      if (!lead.lat || !lead.lng) return;
      const point = [Number(lead.lat), Number(lead.lng)];
      if (pointInPolygon(point, polygon)) {
        inside.push({
          id: lead.id,
          name: lead.name || lead.firstName + ' ' + (lead.lastName || ''),
          address: lead.address,
          stage: lead.stage,
          jobValue: lead.jobValue,
          lat: lead.lat,
          lng: lead.lng,
          distanceFromCenter: center ? distanceMiles(center, point) : null
        });
      }
    });
    // Sort by distance from storm center (hardest hit first)
    inside.sort((a, b) => (a.distanceFromCenter || 0) - (b.distanceFromCenter || 0));
    return inside;
  }

  /**
   * Check every active storm zone for CRM leads inside.
   * Returns { zoneId: [leads] } map.
   */
  function findAllAffectedLeads() {
    const SC = window.StormCenter;
    if (!SC || !SC.getZones) return {};
    const zones = SC.getZones() || [];
    const result = {};
    zones.forEach(zone => {
      const affected = findLeadsInZone(zone);
      if (affected.length) result[zone.id] = affected;
    });
    return result;
  }

  // ═════════════════════════════════════════════════════════
  // 2. Historical proof attachment
  //
  // Stores a storm event on a customer record so adjusters
  // can't push back with "there wasn't a storm that day".
  // Creates a timeline entry + an immutable `stormEvents`
  // array on the lead document.
  // ═════════════════════════════════════════════════════════

  async function attachStormProofToLead(leadId, zone) {
    if (!leadId || !zone) return null;
    if (!window._db || !window.auth?.currentUser) {
      console.warn('[StormIntegration] No Firestore — cannot attach proof');
      return null;
    }
    try {
      const { doc, updateDoc, arrayUnion, addDoc, collection, serverTimestamp } =
        await import("/assets/vendor/firebase/12.19.0/firebase-firestore.js");

      const stormProof = {
        zoneId: zone.id,
        zoneName: zone.name || 'Unnamed storm zone',
        alertType: zone.alertType || zone.type || 'severe_weather',
        severity: zone.severity || 'Unknown',
        effectiveAt: zone.effectiveAt || zone.createdAt || new Date().toISOString(),
        expiresAt: zone.expiresAt || null,
        source: zone.source || 'NWS',
        hailSize: zone.hailSize || null,
        windSpeed: zone.windSpeed || null,
        polygon: zone.polygon || [],
        attachedAt: new Date().toISOString(),
        attachedBy: window.auth.currentUser.uid
      };

      // Append to the lead's stormEvents array
      await updateDoc(doc(window._db, 'leads', leadId), {
        stormEvents: arrayUnion(stormProof),
        lastStormEventAt: new Date().toISOString()
      });

      // Also create a timeline entry on the customer
      await addDoc(collection(window._db, 'notes'), {
        leadId,
        userId: window.auth.currentUser.uid,
        type: 'storm_proof',
        title: `Storm proof attached — ${stormProof.zoneName}`,
        content: `${stormProof.alertType} (${stormProof.severity}) effective ${stormProof.effectiveAt}. Use for adjuster back-check.`,
        metadata: stormProof,
        createdAt: serverTimestamp()
      });

      return stormProof;
    } catch (e) {
      console.error('[StormIntegration] attachStormProofToLead failed:', e);
      return null;
    }
  }

  /**
   * Bulk attach a storm proof to every affected lead in a zone.
   */
  async function attachStormProofToZone(zone) {
    const affected = findLeadsInZone(zone);
    const results = { attached: [], failed: [] };
    for (const lead of affected) {
      const result = await attachStormProofToLead(lead.id, zone);
      if (result) results.attached.push(lead.id);
      else results.failed.push(lead.id);
    }
    return results;
  }

  // ═════════════════════════════════════════════════════════
  // 3. Marketing trigger — generate campaign content
  // ═════════════════════════════════════════════════════════

  /**
   * Generate suggested marketing content for a storm zone.
   * Returns 3 asset types: door hanger, postcard, social post.
   */
  function generateMarketingCampaign(zone, company) {
    company = company || {
      name: 'No Big Deal Home Solutions',
      phone: '(859) 420-7382',
      website: 'nobigdealwithjoedeal.com'
    };
    const eventType = zone.alertType || zone.type || 'severe storm';
    const when = zone.effectiveAt
      ? new Date(zone.effectiveAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
      : 'recently';
    const zoneName = zone.name || 'your neighborhood';

    const doorHanger = {
      type: 'door_hanger',
      headline: 'STORM ON YOUR STREET?',
      subhead: `${eventType} hit ${zoneName} on ${when}. We're inspecting every home for free.`,
      body: [
        '✓ Free, no-obligation roof inspection',
        '✓ Insurance claim assistance from day 1',
        '✓ Licensed + insured in OH + KY',
        '✓ Local crew — not out-of-state storm chasers'
      ],
      cta: `Call ${company.phone} — inspection in 24 hours`,
      footer: `${company.name} · ${company.website}`,
      photos: ['storm_damage_example_1']
    };

    const postcard = {
      type: 'postcard',
      front: {
        headline: `We saw the storm at ${zoneName}.`,
        subhead: 'Your neighbors are already filing claims.',
        visual: 'before_after_split'
      },
      back: {
        body: `A ${eventType} passed through ${zoneName} on ${when}. ` +
              `Hail and wind damage often looks minor from the ground but can shorten your roof's life by years. ` +
              `We're offering free inspections to anyone affected by this storm event.`,
        bullets: [
          'Most homes have damage they can\'t see from the ground',
          'We document everything for your insurance claim',
          'No upfront cost — we work directly with your carrier'
        ],
        cta: `${company.phone}`,
        company: company.name,
        address: company.address || 'Cincinnati / Northern Kentucky'
      }
    };

    const socialPost = {
      type: 'social_post',
      platform: 'facebook',
      text: `🏠 Homeowners in ${zoneName} — did you get hit by the ${eventType} on ${when}?\n\n` +
            `We're doing free roof inspections for everyone in the affected area. ` +
            `We document everything for your insurance claim and work directly with your carrier.\n\n` +
            `Local crew, OH + KY licensed, no out-of-state storm chasers.\n\n` +
            `📞 ${company.phone}\n` +
            `🌐 ${company.website}\n\n` +
            `#roofing #stormrepair #${zoneName.replace(/\s+/g, '')}`,
      hashtags: ['roofing', 'stormrepair', 'insuranceclaim', 'Cincinnati'],
      imageRecommendation: 'wide-shot of storm damage or split before/after'
    };

    const emailBlast = {
      type: 'email_blast',
      subject: `🚨 Storm alert — ${zoneName}`,
      preview: `Free roof inspection for every home in the affected area`,
      body: `We tracked a ${eventType} through ${zoneName} on ${when}. ` +
            `If your home is in this area, you may have damage you can't see from the ground. ` +
            `Reply to this email or call ${company.phone} for a free, no-pressure inspection.`,
      cta: 'Schedule Inspection',
      ctaLink: `https://${company.website}/contact`
    };

    return {
      zone: zone.id,
      zoneName,
      eventType,
      when,
      assets: {
        doorHanger,
        postcard,
        socialPost,
        emailBlast
      },
      suggestedBudget: {
        doorHangers: { qty: 500, cost: 85 },
        postcards: { qty: 1000, cost: 240 },
        facebookAds: { days: 7, cost: 150 },
        total: 475
      }
    };
  }

  // ═════════════════════════════════════════════════════════
  // 4. Heat map data for D2D overlay
  //
  // Converts storm zones into point + intensity pairs that
  // Leaflet.heat can render on the D2D map.
  // ═════════════════════════════════════════════════════════

  function generateHeatMapPoints(zones, resolution) {
    zones = zones || (window.StormCenter && window.StormCenter.getZones()) || [];
    resolution = Number(resolution) || 20;  // Points per zone
    const points = [];

    zones.forEach(zone => {
      if (!zone.polygon || zone.polygon.length < 3) return;
      // Compute bounds from polygon
      const lats = zone.polygon.map(p => p[0]);
      const lngs = zone.polygon.map(p => p[1]);
      const nw = [Math.max(...lats), Math.min(...lngs)];
      const se = [Math.min(...lats), Math.max(...lngs)];
      const cLat = (nw[0] + se[0]) / 2;
      const cLng = (nw[1] + se[1]) / 2;

      // Intensity based on severity
      const baseIntensity = {
        'Extreme': 1.0,
        'Severe': 0.8,
        'Moderate': 0.6,
        'Minor': 0.4,
        'Unknown': 0.3
      }[zone.severity] || 0.5;

      // Scatter points across the polygon with decay from center
      for (let i = 0; i < resolution; i++) {
        const t = i / resolution;
        const angle = t * Math.PI * 2 * 3;  // 3 rotations
        const rLat = (nw[0] - cLat) * (1 - t * 0.8);
        const rLng = (nw[1] - cLng) * (1 - t * 0.8);
        const lat = cLat + Math.cos(angle) * rLat;
        const lng = cLng + Math.sin(angle) * rLng;
        points.push([lat, lng, baseIntensity * (1 - t * 0.5)]);
      }
    });
    return points;
  }

  // ═════════════════════════════════════════════════════════
  // 5. Proactive alert fan-out
  //
  // When a new high-severity storm is detected, queue an
  // alert for the notification system. Non-blocking.
  // ═════════════════════════════════════════════════════════

  function triggerProactiveAlert(zone) {
    if (!zone) return;
    const severity = zone.severity || 'Unknown';
    const isHigh = ['Extreme', 'Severe'].includes(severity);
    if (!isHigh) return;

    const affected = findLeadsInZone(zone);

    const alert = {
      id: 'storm_alert_' + Date.now(),
      type: 'storm',
      severity,
      priority: isHigh ? 'high' : 'normal',
      title: `🚨 ${zone.alertType || 'Storm'} — ${zone.name || 'Service area'}`,
      body: `${severity} severity. ${affected.length} existing CRM leads inside the affected area.`,
      zoneId: zone.id,
      affectedLeadCount: affected.length,
      actions: [
        { label: 'Push to D2D', fn: 'StormCenter.pushToD2D', arg: zone.id },
        { label: 'Attach proof to affected leads', fn: 'StormIntegration.attachStormProofToZone', arg: zone.id },
        { label: 'Generate marketing campaign', fn: 'StormIntegration.generateMarketingCampaign', arg: zone.id }
      ],
      createdAt: new Date().toISOString()
    };

    // Save to local notification queue (consumed by the alert UI)
    try {
      const queue = JSON.parse(localStorage.getItem('nbd_notification_queue') || '[]');
      queue.unshift(alert);
      localStorage.setItem('nbd_notification_queue', JSON.stringify(queue.slice(0, 50)));
    } catch (e) {}

    // Fire a toast if the UI is up
    if (typeof window.showToast === 'function') {
      window.showToast(alert.title + ' — ' + alert.body, 'warning');
    }

    return alert;
  }

  /**
   * Scan all active storm zones for high-severity alerts that
   * haven't fired yet. Intended to run on a timer or manually.
   */
  function scanForNewAlerts() {
    const SC = window.StormCenter;
    if (!SC) return [];
    const zones = SC.getZones() || [];
    const fired = JSON.parse(localStorage.getItem('nbd_fired_storm_alerts') || '[]');
    const firedSet = new Set(fired);
    const newAlerts = [];

    zones.forEach(zone => {
      if (firedSet.has(zone.id)) return;
      const alert = triggerProactiveAlert(zone);
      if (alert) {
        newAlerts.push(alert);
        firedSet.add(zone.id);
      }
    });

    if (firedSet.size !== fired.length) {
      try {
        localStorage.setItem('nbd_fired_storm_alerts', JSON.stringify([...firedSet]));
      } catch (e) {}
    }
    return newAlerts;
  }

  // ═════════════════════════════════════════════════════════
  // idea #1 Phase 2 — server-verified storm proof (per-lead)
  // ═════════════════════════════════════════════════════════
  // The card-detail "🛡️ Storm Proof" button calls this. Unlike the Phase-1
  // client attach (attachStormProofToLead — a client-written stormEvents[]
  // entry), this hits the attachStormProof callable, which looks up VERIFIED
  // hail near the address server-side and writes an immutable, server-stamped
  // record to leads/{id}/storm_proofs — adjuster-grade evidence.
  async function verifyStormProofForLead() {
    var leadId = window._cardDetailLeadId;
    if (!leadId) { if (window.showToast) window.showToast('Open a lead first', 'info'); return; }
    try {
      if (!window._functions || !window._httpsCallable) {
        var mod = await import('/assets/vendor/firebase/12.19.0/firebase-functions.js');
        window._functions = window._functions || mod.getFunctions();
        window._httpsCallable = window._httpsCallable || mod.httpsCallable;
      }
      if (window.showToast) window.showToast('Checking verified hail history…', 'info');
      var fn = window._httpsCallable(window._functions, 'attachStormProof');
      var res = await fn({ leadId: leadId });
      var out = (res && res.data) || {};
      if (out.verified) {
        var sz = out.maxSizeInches ? (Math.round(out.maxSizeInches * 100) / 100) + '" hail' : (out.hitCount + ' reports');
        if (window.showToast) window.showToast('✅ Verified storm proof attached — ' + sz, 'ok');
      } else {
        if (window.showToast) window.showToast('No qualifying hail (≥0.75") found for this address in the window' + (out.hitCount ? ' (' + out.hitCount + ' minor reports)' : '') + '.', 'info');
      }
    } catch (e) {
      var msg = (e && (e.message || (e.details && e.details.message))) || 'error';
      if (window.showToast) window.showToast('Storm check failed: ' + msg, 'error');
    }
  }

  // Register on the CSP-safe call registry (resolved by the data-action="call"
  // delegate; keeps it off the _NBD_CALL_ALLOWLIST bare-window path). Uses the
  // Object.assign form the smoke wiring-audit scans for.
  window.__NBD_CALL_REGISTRY = window.__NBD_CALL_REGISTRY || Object.create(null);
  Object.assign(window.__NBD_CALL_REGISTRY, {
    verifyStormProofForLead: verifyStormProofForLead
  });

  // ═════════════════════════════════════════════════════════
  // Public API
  // ═════════════════════════════════════════════════════════

  window.StormIntegration = {
    // Geo helpers
    pointInPolygon,
    distanceMiles,

    // CRM cross-reference
    findLeadsInZone,
    findAllAffectedLeads,

    // Historical proof
    attachStormProofToLead,
    attachStormProofToZone,
    verifyStormProofForLead,   // idea #1 Phase 2 — server-verified, immutable

    // Marketing
    generateMarketingCampaign,

    // Heat map
    generateHeatMapPoints,

    // Proactive alerts
    triggerProactiveAlert,
    scanForNewAlerts
  };

  console.log('[StormIntegration] Storm integration layer ready.');
})();
