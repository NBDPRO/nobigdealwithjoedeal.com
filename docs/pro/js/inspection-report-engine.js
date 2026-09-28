/**
 * Inspection Report Engine - NBD Pro Roofing CRM
 * Comprehensive report generation for roofing inspections
 *
 * Depends on:
 * - window._db (Firestore)
 * - window._user, window._auth, window._storage (Firebase)
 * - window._leads (array of lead objects)
 * - window.PhotoEngine (photo management) - gracefully degrades if unavailable
 * - window.showToast(msg, type) - toast notifications
 * - CSS variables: --s, --s2, --t, --m, --br, --orange
 *
 * Exposes: window.InspectionReportEngine
 */

(function() {
  'use strict';

  // Brand constants
  //
  // gauntlet Batch 3 — the CLIENT-side report bodies below (_generateFullInspection,
  // _generateStormDamage, _generateSupplement, _generateCompletion — the fallback
  // rendered when the server render is unavailable) hardcoded NBD, so a stranger
  // tenant's cover/footer still read "No Big Deal Home Solutions · (859) 420-7382".
  // window._brand() (company-profile.js / TenantContext) now drives
  // name/phone/email/website so the client body carries THAT tenant's identity.
  // NBD (no brand, or the canonical NBD legalName) resolves to the exact literals
  // below → the body renders BYTE-IDENTICAL for NBD. LAZY GETTERS (per access, all
  // at render time) because this IIFE can run before company-profile.js registers
  // window._brand. colors stay static (cosmetic). Mirrors customer-portal.js.
  function _brandRaw() {
    try { if (typeof window._brand === 'function') return window._brand() || {}; } catch (e) { /* fall through */ }
    return {};
  }
  function _isNbdBrand(b) { return !b || !b.legalName || b.legalName === 'No Big Deal Home Solutions'; }
  const BRAND = {
    get name()    { const b = _brandRaw(); return _isNbdBrand(b) ? 'No Big Deal Home Solutions'    : (b.legalName || 'No Big Deal Home Solutions'); },
    // Non-NBD branch falls back to '' (NOT the NBD literal): _resolveBrand()
    // blanks an unset tenant contact field to '', so `|| NBD-literal` would
    // re-leak Joe's number/email/site onto a stranger's cover. NBD unchanged.
    get phone()   { const b = _brandRaw(); return _isNbdBrand(b) ? '(859) 420-7382'                : ((b.contact && b.contact.phone)   || ''); },
    get email()   { const b = _brandRaw(); return _isNbdBrand(b) ? 'info@nobigdealwithjoedeal.com' : ((b.contact && b.contact.email)   || ''); },
    get website() { const b = _brandRaw(); return _isNbdBrand(b) ? 'nobigdealwithjoedeal.com'      : ((b.contact && b.contact.website) || ''); },
    colors: {
      navy: '#1A3057',
      orange: '#BD5728'
    }
  };

  // Template definitions
  const TEMPLATES = {
    FULL_INSPECTION: {
      id: 'full-inspection',
      name: 'Full Roof Inspection Report',
      description: 'Comprehensive roof inspection with components checklist',
      icon: '📋'
    },
    STORM_DAMAGE: {
      id: 'storm-damage',
      name: 'Storm Damage Assessment',
      description: 'Hail/wind damage documentation and insurance claim support',
      icon: '⛈️'
    },
    SUPPLEMENT: {
      id: 'supplement',
      name: 'Insurance Supplement Request',
      description: 'Additional scope items discovered after initial estimate',
      icon: '📝'
    },
    COMPLETION: {
      id: 'completion',
      name: 'Project Completion Report',
      description: 'Work performed, materials used, before/after photos',
      icon: '✅'
    }
  };

  // Roof components for Full Inspection
  const ROOF_COMPONENTS = [
    'Shingles/Material', 'Ridge Caps', 'Hip Caps', 'Starter Strip',
    'Drip Edge', 'Flashing (Wall)', 'Flashing (Chimney)', 'Flashing (Valley)',
    'Flashing (Pipe Boots)', 'Valleys', 'Gutters', 'Downspouts', 'Fascia',
    'Soffit', 'Ridge Vent', 'Box Vents', 'Soffit Vents', 'Skylights',
    'Chimney', 'Satellite Dishes/Mounts', 'Decking'
  ];

  // Condition ratings
  const CONDITIONS = ['Good', 'Fair', 'Poor', 'Critical'];
  const SEVERITY_LEVELS = [1, 2, 3, 4, 5];

  // Work-completed checklist items (Project Completion report)
  const COMPLETION_WORK_ITEMS = [
    'Tear-off', 'Decking repair/replacement', 'Ice & water shield',
    'Synthetic underlayment', 'Drip edge', 'Starter strip', 'Field shingles',
    'Ridge caps', 'Pipe boots', 'Wall flashing', 'Chimney flashing',
    'Valley metal', 'Ventilation', 'Gutters', 'Cleanup', 'Final inspection'
  ];

  // Report storage
  const REPORTS_COLLECTION = 'reports';
  const STORAGE_KEY_DRAFT = 'nbd_report_draft_';

  /**
   * Main Engine Object
   */
  const Engine = {
    /**
     * Get all available templates
     */
    getTemplates() {
      return Object.values(TEMPLATES);
    },

    /**
     * Get a specific template by ID
     */
    getTemplate(templateId) {
      return Object.values(TEMPLATES).find(t => t.id === templateId);
    },

    /**
     * Get reports for a lead
     */
    async getReports(leadId) {
      try {
        if (!window._db) return [];

        const { collection, getDocs, query, where, orderBy } = await import(
          'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
        );

        const q = query(
          collection(window._db, REPORTS_COLLECTION),
          where('leadId', '==', leadId),
          orderBy('createdAt', 'desc')
        );

        const snapshot = await getDocs(q);
        return snapshot.docs.map(doc => ({
          id: doc.id,
          ...doc.data()
        }));
      } catch (err) {
        console.error('Error fetching reports:', err);
        return [];
      }
    },

    /**
     * Save a report to Firestore
     */
    async saveReport(leadId, templateId, reportData) {
      try {
        if (!window._db || !window._user) {
          showToast('Database or user not available', 'error');
          return null;
        }

        const { collection, doc, setDoc, serverTimestamp } = await import(
          'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
        );

        const reportId = `report_${Date.now()}`;
        const reportDoc = {
          leadId,
          templateId,
          type: this.getTemplate(templateId)?.name,
          status: 'complete',
          createdAt: serverTimestamp(),
          // The /reports security rule keys ownership off `userId`
          // (create: request.resource.data.userId == auth.uid; read+delete:
          // isOwner(resource.data.userId)). Without it every save was denied
          // permission-denied and silently toasted "Failed to save report" —
          // the headline "Save to database" feature (INSP-1) never persisted.
          // Keep createdBy too for display/back-compat.
          userId: window._user.uid,
          // companyId enables same-company team visibility (firestore.rules
          // /reports read: sameCompanyAsResource()). Mirrors lead-creation's
          // claim-or-uid fallback so solo owners get their own uid as the scope.
          companyId: (window._userClaims && window._userClaims.companyId) || window._user.uid,
          createdBy: window._user.uid,
          html: reportData.html,
          data: reportData.data,
          photoIds: reportData.photoIds || [],
          metadata: {
            propertyAddress: reportData.propertyAddress,
            inspectorName: reportData.inspectorName,
            inspectionDate: reportData.inspectionDate
          }
        };

        await setDoc(doc(window._db, REPORTS_COLLECTION, reportId), reportDoc);
        showToast('Report saved successfully', 'success');
        return reportId;
      } catch (err) {
        console.error('Error saving report:', err);
        showToast('Failed to save report', 'error');
        return null;
      }
    },

    /**
     * Delete a report
     */
    async deleteReport(reportId) {
      try {
        if (!window._db) return false;

        const { collection, doc, deleteDoc } = await import(
          'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
        );

        await deleteDoc(doc(window._db, REPORTS_COLLECTION, reportId));
        showToast('Report deleted', 'success');
        return true;
      } catch (err) {
        console.error('Error deleting report:', err);
        showToast('Failed to delete report', 'error');
        return false;
      }
    },

    /**
     * Mint a no-login share link for a saved report and surface it to the rep
     * (copies to clipboard + shows the URL). The link is served by the
     * getSharedReport Cloud Function at /report/<token>; the homeowner needs no
     * account. See functions/report-sharing.js.
     */
    async _shareReport(reportId) {
      if (!reportId) return;
      try {
        if (!window._functions || !window._httpsCallable) {
          const mod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js');
          window._functions = window._functions || mod.getFunctions();
          window._httpsCallable = window._httpsCallable || mod.httpsCallable;
        }
        showToast('Creating share link…', 'info');
        const fn = window._httpsCallable(window._functions, 'createReportShareToken');
        const res = await fn({ reportId });
        const data = (res && res.data) || {};
        const url = data.shareUrl;
        if (!url) { showToast('Could not create share link', 'error'); return; }
        let copied = false;
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(url);
            copied = true;
          }
        } catch (_) { /* clipboard blocked — fall back to prompt */ }
        // The function auto-emails the homeowner when an email is on file; tell
        // the rep what happened so they know whether to send it manually.
        if (data.emailed && data.sentTo) {
          showToast('✓ Report emailed to ' + data.sentTo + (copied ? ' · link copied' : ''), 'success');
        } else {
          showToast(copied ? '✓ Share link copied (no email on file — send it manually)' : 'Share link ready', 'success');
        }
        // Always surface the URL so the rep can copy/send it even if the
        // clipboard write was blocked (non-secure context / permissions).
        if (typeof window.prompt === 'function') {
          window.prompt('Report link for the homeowner (expires in 30 days):', url);
        }
      } catch (err) {
        console.error('Error sharing report:', err);
        showToast('Failed to create share link: ' + ((err && err.message) || 'unknown'), 'error');
      }
    },

    /**
     * Generate report HTML from template and data
     */
    generateReport(leadId, templateId, data) {
      const template = this.getTemplate(templateId);
      if (!template) {
        showToast('Invalid template', 'error');
        return null;
      }

      let html = '';
      switch (templateId) {
        case 'full-inspection':
          html = this._generateFullInspection(leadId, data);
          break;
        case 'storm-damage':
          html = this._generateStormDamage(leadId, data);
          break;
        case 'supplement':
          html = this._generateSupplement(leadId, data);
          break;
        case 'completion':
          html = this._generateCompletion(leadId, data);
          break;
      }

      return html;
    },

    /**
     * Generate Full Inspection Report
     */
    _generateFullInspection(leadId, data) {
      const lead = this._effectiveLead(leadId, data);
      if (!lead) return '';

      const {
        roofType, roofAge, totalSquares, slopes,
        components = {}, damageAssessment = {}, recommendations = '',
        inspectorName, inspectionDate, estimatedWork = []
      } = data;

      // Sum the rep-entered per-row costs (legacy drafts used `total`)
      // for the scope footer. 0 → footer omitted.
      const scopeTotal = (Array.isArray(estimatedWork) ? estimatedWork : []).reduce((s, it) => {
        const c = Number(it && (it.cost != null ? it.cost : it.total));
        return s + (isFinite(c) ? c : 0);
      }, 0);

      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Roof Inspection Report</title>
          <style>
            ${this._getPrintStyles()}
          </style>
        </head>
        <body>
          <div class="report-container">
            <!-- COVER PAGE -->
            <div class="page cover-page">
              <div class="cover-header">
                <div class="brand-logo" style="font-size: 24px; font-weight: bold; color: ${BRAND.colors.navy};display:flex;align-items:center;gap:12px;">
                  ${this._brandLogoImg()}<span>${this._escapeHtml(BRAND.name)}</span>
                </div>
                <div class="cover-title">FULL ROOF INSPECTION REPORT</div>
              </div>

              <div class="cover-content">
                <div class="cover-section">
                  <h3>Property Address</h3>
                  <p>${this._escapeHtml(lead.address || 'N/A')}</p>
                </div>

                <div class="cover-section">
                  <h3>Property Owner</h3>
                  <p>${this._escapeHtml(lead.name || 'N/A')}</p>
                </div>

                <div class="cover-section">
                  <h3>Inspection Date</h3>
                  <p>${this._escapeHtml(inspectionDate || new Date().toLocaleDateString())}</p>
                </div>

                <div class="cover-section">
                  <h3>Inspector</h3>
                  <p>${this._escapeHtml(inspectorName || 'N/A')}</p>
                </div>
              </div>

              <div class="cover-footer">
                <p>${this._escapeHtml(BRAND.phone)} | ${this._escapeHtml(BRAND.email)}</p>
                <p>${this._escapeHtml(BRAND.website)}</p>
              </div>
            </div>

            <!-- PROPERTY OVERVIEW -->
            <div class="page">
              <h1>Property Overview</h1>

              <table class="info-table">
                <tr>
                  <td><strong>Address:</strong></td>
                  <td>${this._escapeHtml(lead.address || 'N/A')}</td>
                </tr>
                <tr>
                  <td><strong>Owner Name:</strong></td>
                  <td>${this._escapeHtml(lead.name || 'N/A')}</td>
                </tr>
                <tr>
                  <td><strong>Phone:</strong></td>
                  <td>${this._escapeHtml(lead.phone || 'N/A')}</td>
                </tr>
                <tr>
                  <td><strong>Email:</strong></td>
                  <td>${this._escapeHtml(lead.email || 'N/A')}</td>
                </tr>
                <tr>
                  <td><strong>Roof Type:</strong></td>
                  <td>${this._escapeHtml(roofType || 'N/A')}</td>
                </tr>
                <tr>
                  <td><strong>Approximate Age:</strong></td>
                  <td>${roofAge ? roofAge + ' years' : 'N/A'}</td>
                </tr>
                <tr>
                  <td><strong>Total Squares:</strong></td>
                  <td>${totalSquares || 'N/A'}</td>
                </tr>
                <tr>
                  <td><strong>Number of Slopes:</strong></td>
                  <td>${slopes || 'N/A'}</td>
                </tr>
              </table>
            </div>

            <!-- ROOF COMPONENTS CHECKLIST -->
            <div class="page">
              <h1>Roof Components Checklist</h1>

              <table class="checklist-table">
                <thead>
                  <tr>
                    <th>Component</th>
                    <th>Condition</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  ${ROOF_COMPONENTS.map(component => {
                    const compData = components[component] || {};
                    return `
                      <tr>
                        <td><strong>${component}</strong></td>
                        <td><span class="condition-badge condition-${compData.condition?.toLowerCase() || 'unknown'}">${compData.condition || '—'}</span></td>
                        <td>${this._escapeHtml(compData.notes || '')}</td>
                      </tr>
                    `;
                  }).join('')}
                </tbody>
              </table>
            </div>

            <!-- DAMAGE ASSESSMENT -->
            ${damageAssessment.type ? `
            <div class="page">
              <h1>Damage Assessment</h1>

              <table class="info-table">
                <tr>
                  <td><strong>Damage Type:</strong></td>
                  <td>${this._escapeHtml(damageAssessment.type)}</td>
                </tr>
                <tr>
                  <td><strong>Severity (1-5):</strong></td>
                  <td>${damageAssessment.severity || '—'}</td>
                </tr>
                <tr>
                  <td><strong>Affected Area:</strong></td>
                  <td>${damageAssessment.area ? damageAssessment.area + ' sq ft' : '—'}</td>
                </tr>
                <tr>
                  <td><strong>Location on Roof:</strong></td>
                  <td>${this._escapeHtml(damageAssessment.location || '—')}</td>
                </tr>
              </table>

              ${damageAssessment.description ? `
              <h2 style="margin-top: 20px;">Details</h2>
              <p>${this._escapeHtml(damageAssessment.description)}</p>
              ` : ''}
            </div>
            ` : ''}

            <!-- PHOTOS -->
            ${data.photos && data.photos.length > 0 ? `
            <div class="page">
              <h1>Photo Documentation</h1>
              <div class="photo-grid">
                ${data.photos.map(photo => `
                  <div class="photo-item">
                    <img src="${this._escapeHtml(photo.url)}" alt="Inspection photo">
                    ${photo.description ? `<p class="photo-caption">${this._escapeHtml(photo.description)}</p>` : ''}
                    ${this._renderPhotoAIAnalysis(photo)}
                  </div>
                `).join('')}
              </div>
            </div>
            ` : ''}

            <!-- RECOMMENDATIONS -->
            ${recommendations ? `
            <div class="page">
              <h1>Recommendations</h1>
              <p>${this._escapeHtml(recommendations)}</p>
            </div>
            ` : ''}

            <!-- ESTIMATED SCOPE OF WORK -->
            ${estimatedWork && estimatedWork.length > 0 ? `
            <div class="page">
              <h1>Estimated Scope of Work</h1>

              <table class="work-table">
                <thead>
                  <tr>
                    <th>Area</th>
                    <th>Description</th>
                    <th>Severity</th>
                    <th>Qty</th>
                    <th>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  ${estimatedWork.map(item => {
                    const qty = item.quantity != null ? item.quantity : (item.qty != null ? item.qty : '');
                    const cost = Number(item.cost != null ? item.cost : item.total);
                    return `
                    <tr>
                      <td>${this._escapeHtml(item.area || '')}</td>
                      <td>${this._escapeHtml(item.description || item.item || '')}${item.notes ? `<div style="font-size:11px;color:#666;margin-top:3px;">${this._escapeHtml(item.notes)}</div>` : ''}</td>
                      <td>${this._escapeHtml(item.severity || '')}</td>
                      <td>${this._escapeHtml(String(qty)) || '—'}</td>
                      <td>${isFinite(cost) ? '$' + cost.toLocaleString('en-US') : '—'}</td>
                    </tr>
                  `;}).join('')}
                </tbody>
                ${scopeTotal > 0 ? `
                <tfoot>
                  <tr>
                    <td colspan="4" style="text-align:right;font-weight:bold;">Estimated total scope value</td>
                    <td style="font-weight:bold;">$${scopeTotal.toLocaleString('en-US')}</td>
                  </tr>
                </tfoot>
                ` : ''}
              </table>
            </div>
            ` : ''}

            <!-- SIGNATURE PAGE -->
            <div class="page">
              <h1>Inspector Certification</h1>

              <div style="margin-top: 40px;">
                <p><strong>Inspector Name:</strong> ${this._escapeHtml(inspectorName || '________')}</p>
                <p style="margin-top: 30px;"><strong>Signature:</strong> _________________________ <strong>Date:</strong> _______________</p>
              </div>

              <hr style="margin: 40px 0;">

              <h2>Disclaimer</h2>
              <p style="font-size: 11px; line-height: 1.6;">
                This inspection report is based on visual observation only and does not constitute a warranty or guarantee.
                Opinions expressed are those of the inspector and may be subject to change upon further investigation.
                This report does not provide structural engineering analysis or estimate future maintenance costs.
                For detailed analysis, consult with a professional engineer or contractor.
              </p>
            </div>
          </div>
        </body>
        </html>
      `;

      return html;
    },

    /**
     * Generate Storm Damage Assessment
     */
    _generateStormDamage(leadId, data) {
      const lead = this._effectiveLead(leadId, data);
      if (!lead) return '';

      const {
        stormDate, stormType, hailSize, windSpeed,
        roofDamage = {}, sidingDamage = {}, gutterDamage = {},
        windowDamage = {}, screenDamage = {}, interiorDamage = {},
        testSquare = {}, collateralDamage = {}, notes = '',
        inspectorName, recommendations = ''
      } = data;

      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Storm Damage Assessment</title>
          <style>
            ${this._getPrintStyles()}
          </style>
        </head>
        <body>
          <div class="report-container">
            <!-- COVER PAGE -->
            <div class="page cover-page">
              <div class="cover-header">
                <div class="brand-logo" style="font-size: 24px; font-weight: bold; color: ${BRAND.colors.navy};display:flex;align-items:center;gap:12px;">
                  ${this._brandLogoImg()}<span>${this._escapeHtml(BRAND.name)}</span>
                </div>
                <div class="cover-title">STORM DAMAGE ASSESSMENT</div>
              </div>

              <div class="cover-content">
                <div class="cover-section">
                  <h3>Property Address</h3>
                  <p>${this._escapeHtml(lead.address || 'N/A')}</p>
                </div>

                <div class="cover-section">
                  <h3>Storm Date</h3>
                  <p>${this._escapeHtml(stormDate || 'N/A')}</p>
                </div>

                <div class="cover-section">
                  <h3>Storm Type</h3>
                  <p>${this._escapeHtml(stormType || 'N/A')}</p>
                </div>

                <div class="cover-section">
                  <h3>Inspector</h3>
                  <p>${this._escapeHtml(inspectorName || 'N/A')}</p>
                </div>
              </div>

              <div class="cover-footer">
                <p>${this._escapeHtml(BRAND.phone)} | ${this._escapeHtml(BRAND.email)}</p>
              </div>
            </div>

            <!-- STORM EVENT INFO -->
            <div class="page">
              <h1>Storm Event Information</h1>

              <table class="info-table">
                <tr>
                  <td><strong>Date of Storm:</strong></td>
                  <td>${this._escapeHtml(stormDate || 'N/A')}</td>
                </tr>
                <tr>
                  <td><strong>Type of Storm:</strong></td>
                  <td>${this._escapeHtml(stormType || 'N/A')}</td>
                </tr>
                ${hailSize ? `
                <tr>
                  <td><strong>Hail Size:</strong></td>
                  <td>${this._escapeHtml(hailSize)}</td>
                </tr>
                ` : ''}
                ${windSpeed ? `
                <tr>
                  <td><strong>Wind Speed:</strong></td>
                  <td>${this._escapeHtml(windSpeed)}</td>
                </tr>
                ` : ''}
              </table>
            </div>

            <!-- EXTERIOR INSPECTION SUMMARY -->
            <div class="page">
              <h1>Exterior Inspection Summary</h1>

              ${this._renderDamageSection('Roof', roofDamage)}
              ${this._renderDamageSection('Siding', sidingDamage)}
              ${this._renderDamageSection('Gutters & Downspouts', gutterDamage)}
              ${this._renderDamageSection('Windows', windowDamage)}
              ${this._renderDamageSection('Screens', screenDamage)}
            </div>

            <!-- TEST SQUARE RESULTS -->
            ${testSquare.location ? `
            <div class="page">
              <h1>Test Square Results</h1>

              <table class="info-table">
                <tr>
                  <td><strong>Location:</strong></td>
                  <td>${this._escapeHtml(testSquare.location)}</td>
                </tr>
                <tr>
                  <td><strong>Dimensions:</strong></td>
                  <td>${this._escapeHtml(testSquare.dimensions || 'N/A')}</td>
                </tr>
                <tr>
                  <td><strong>Hits Counted:</strong></td>
                  <td>${testSquare.hits || 'N/A'}</td>
                </tr>
                <tr>
                  <td><strong>Measurements:</strong></td>
                  <td>${this._escapeHtml(testSquare.measurements || 'N/A')}</td>
                </tr>
              </table>
            </div>
            ` : ''}

            <!-- INTERIOR DAMAGE -->
            ${Object.keys(interiorDamage).length > 0 ? `
            <div class="page">
              <h1>Interior Damage Assessment</h1>

              <table class="info-table">
                ${interiorDamage.waterStains ? `
                <tr>
                  <td><strong>Water Stains:</strong></td>
                  <td>${this._escapeHtml(interiorDamage.waterStains)}</td>
                </tr>
                ` : ''}
                ${interiorDamage.activeLeaks ? `
                <tr>
                  <td><strong>Active Leaks:</strong></td>
                  <td>${this._escapeHtml(interiorDamage.activeLeaks)}</td>
                </tr>
                ` : ''}
                ${interiorDamage.atticObservations ? `
                <tr>
                  <td><strong>Attic Observations:</strong></td>
                  <td>${this._escapeHtml(interiorDamage.atticObservations)}</td>
                </tr>
                ` : ''}
              </table>
            </div>
            ` : ''}

            <!-- COLLATERAL DAMAGE -->
            ${Object.keys(collateralDamage).length > 0 ? `
            <div class="page">
              <h1>Collateral Damage Evidence</h1>

              <p style="margin-bottom: 15px;">Additional damage found at property:</p>
              <ul>
                ${collateralDamage.acUnits ? `<li>AC Units: ${this._escapeHtml(collateralDamage.acUnits)}</li>` : ''}
                ${collateralDamage.vents ? `<li>Vents: ${this._escapeHtml(collateralDamage.vents)}</li>` : ''}
                ${collateralDamage.mailbox ? `<li>Mailbox: ${this._escapeHtml(collateralDamage.mailbox)}</li>` : ''}
                ${collateralDamage.fencing ? `<li>Fencing: ${this._escapeHtml(collateralDamage.fencing)}</li>` : ''}
                ${collateralDamage.vehicles ? `<li>Vehicles: ${this._escapeHtml(collateralDamage.vehicles)}</li>` : ''}
                ${collateralDamage.landscaping ? `<li>Landscaping: ${this._escapeHtml(collateralDamage.landscaping)}</li>` : ''}
              </ul>
            </div>
            ` : ''}

            <!-- PHOTOS -->
            ${data.photos && data.photos.length > 0 ? `
            <div class="page">
              <h1>Damage Documentation Photos</h1>
              <div class="photo-grid">
                ${data.photos.map(photo => `
                  <div class="photo-item">
                    <img src="${this._escapeHtml(photo.url)}" alt="Damage photo">
                    ${photo.description ? `<p class="photo-caption">${this._escapeHtml(photo.description)}</p>` : ''}
                    ${this._renderPhotoAIAnalysis(photo)}
                  </div>
                `).join('')}
              </div>
            </div>
            ` : ''}

            <!-- INSURANCE RECOMMENDATION & NEXT STEPS -->
            <div class="page">
              <h1>Insurance Recommendation</h1>

              <p><strong>File Insurance Claim:</strong> ${recommendations.fileClaim ? 'YES' : 'NO'}</p>

              ${recommendations.estimatedScope ? `
              <h2 style="margin-top: 20px;">Estimated Scope</h2>
              <p>${this._escapeHtml(recommendations.estimatedScope)}</p>
              ` : ''}

              ${recommendations.nextSteps ? `
              <h2 style="margin-top: 20px;">Recommended Next Steps</h2>
              <p>${this._escapeHtml(recommendations.nextSteps)}</p>
              ` : ''}

              ${notes ? `
              <h2 style="margin-top: 20px;">Inspector Notes</h2>
              <p>${this._escapeHtml(notes)}</p>
              ` : ''}
            </div>

            <!-- ADJUSTER MEETING NOTES -->
            <div class="page">
              <h1>Adjuster Meeting Notes</h1>

              <p style="margin-bottom: 15px;"><strong>Adjuster Name:</strong> ___________________________</p>
              <p style="margin-bottom: 30px;"><strong>Meeting Date:</strong> ___________________________</p>

              <div style="border: 1px solid #ccc; padding: 20px; height: 300px; background: #fafafa;">
                <!-- Space for notes -->
              </div>
            </div>
          </div>
        </body>
        </html>
      `;

      return html;
    },

    /**
     * Generate Insurance Supplement Report
     */
    _generateSupplement(leadId, data) {
      const lead = this._effectiveLead(leadId, data);
      if (!lead) return '';

      const {
        claimNumber, policyNumber, originalItems = [],
        supplementalItems = [], inspectorName, notes = ''
      } = data;

      const supplementTotal = (supplementalItems || []).reduce((sum, item) => {
        const lineTotal = (parseFloat(item.unitCost || 0) * parseFloat(item.quantity || 0)) || 0;
        return sum + lineTotal;
      }, 0);

      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Insurance Supplement Request</title>
          <style>
            ${this._getPrintStyles()}
          </style>
        </head>
        <body>
          <div class="report-container">
            <!-- HEADER PAGE -->
            <div class="page cover-page">
              <div class="cover-header">
                <div class="brand-logo" style="font-size: 24px; font-weight: bold; color: ${BRAND.colors.navy};display:flex;align-items:center;gap:12px;">
                  ${this._brandLogoImg()}<span>${this._escapeHtml(BRAND.name)}</span>
                </div>
                <div class="cover-title" style="color: ${BRAND.colors.orange}; margin-top: 40px;">SUPPLEMENT REQUEST</div>
              </div>

              <div class="cover-content">
                <div class="cover-section">
                  <h3>Property Address</h3>
                  <p>${this._escapeHtml(lead.address || 'N/A')}</p>
                </div>

                ${claimNumber ? `
                <div class="cover-section">
                  <h3>Claim Number</h3>
                  <p>${this._escapeHtml(claimNumber)}</p>
                </div>
                ` : ''}

                ${policyNumber ? `
                <div class="cover-section">
                  <h3>Policy Number</h3>
                  <p>${this._escapeHtml(policyNumber)}</p>
                </div>
                ` : ''}
              </div>
            </div>

            <!-- ORIGINAL ESTIMATE SUMMARY -->
            ${originalItems && originalItems.length > 0 ? `
            <div class="page">
              <h1>Original Estimate Summary</h1>

              <table class="work-table">
                <thead>
                  <tr>
                    <th>Description</th>
                    <th>Unit</th>
                    <th>Qty</th>
                    <th>Unit Cost</th>
                    <th>Total</th>
                  </tr>
                </thead>
                <tbody>
                  ${originalItems.map(item => {
                    const lineTotal = (parseFloat(item.unitCost || 0) * parseFloat(item.qty || 0)) || 0;
                    return `
                      <tr>
                        <td>${this._escapeHtml(item.description || '')}</td>
                        <td>${this._escapeHtml(item.unit || '')}</td>
                        <td>${item.qty || '—'}</td>
                        <td>$${parseFloat(item.unitCost || 0).toFixed(2)}</td>
                        <td>$${lineTotal.toFixed(2)}</td>
                      </tr>
                    `;
                  }).join('')}
                </tbody>
              </table>
            </div>
            ` : ''}

            <!-- SUPPLEMENTAL ITEMS -->
            <div class="page">
              <h1>Supplemental Items</h1>

              <table class="work-table">
                <thead>
                  <tr>
                    <th>Description</th>
                    <th>Reason</th>
                    <th>Qty</th>
                    <th>Unit Cost</th>
                    <th>Total</th>
                  </tr>
                </thead>
                <tbody>
                  ${supplementalItems.map(item => {
                    const lineTotal = (parseFloat(item.unitCost || 0) * parseFloat(item.quantity || 0)) || 0;
                    return `
                      <tr>
                        <td>
                          <strong>${this._escapeHtml(item.description || '')}</strong>
                          ${item.xactCode ? `<br><small>Xact Code: ${this._escapeHtml(item.xactCode)}</small>` : ''}
                        </td>
                        <td>${this._escapeHtml(item.reason || '')}</td>
                        <td>${item.quantity || '—'}</td>
                        <td>$${parseFloat(item.unitCost || 0).toFixed(2)}</td>
                        <td>$${lineTotal.toFixed(2)}</td>
                      </tr>
                    `;
                  }).join('')}
                </tbody>
              </table>

              <div style="text-align: right; margin-top: 20px; font-weight: bold; font-size: 16px;">
                <p>Total Supplement Amount: <span style="color: ${BRAND.colors.orange};">$${supplementTotal.toFixed(2)}</span></p>
              </div>
            </div>

            <!-- PHOTOS -->
            ${data.photos && data.photos.length > 0 ? `
            <div class="page">
              <h1>Supporting Photo Evidence</h1>
              <div class="photo-grid">
                ${data.photos.map(photo => `
                  <div class="photo-item">
                    <img src="${this._escapeHtml(photo.url)}" alt="Evidence photo">
                    ${photo.description ? `<p class="photo-caption">${this._escapeHtml(photo.description)}</p>` : ''}
                  </div>
                `).join('')}
              </div>
            </div>
            ` : ''}

            <!-- INSPECTOR NOTES & SIGN-OFF -->
            <div class="page">
              <h1>Inspector Certification</h1>

              ${notes ? `
              <h2>Inspector Notes</h2>
              <p>${this._escapeHtml(notes)}</p>
              ` : ''}

              <div style="margin-top: 40px;">
                <p><strong>Inspector Name:</strong> ${this._escapeHtml(inspectorName || '________')}</p>
                <p style="margin-top: 30px;"><strong>Signature:</strong> _________________________ <strong>Date:</strong> _______________</p>
              </div>
            </div>
          </div>
        </body>
        </html>
      `;

      return html;
    },

    /**
     * Generate Project Completion Report
     */
    _generateCompletion(leadId, data) {
      const lead = this._effectiveLead(leadId, data);
      if (!lead) return '';

      const {
        startDate, endDate, crewInfo,
        materials = {}, workCompleted = {},
        warrantyInfo = {}, maintenanceTips = '',
        inspectorName
      } = data;

      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Project Completion Report</title>
          <style>
            ${this._getPrintStyles()}
          </style>
        </head>
        <body>
          <div class="report-container">
            <!-- COVER PAGE -->
            <div class="page cover-page">
              <div class="cover-header">
                <div class="brand-logo" style="font-size: 24px; font-weight: bold; color: ${BRAND.colors.navy};display:flex;align-items:center;gap:12px;">
                  ${this._brandLogoImg()}<span>${this._escapeHtml(BRAND.name)}</span>
                </div>
                <div class="cover-title">PROJECT COMPLETION REPORT</div>
              </div>

              <div class="cover-content">
                <div class="cover-section">
                  <h3>Property Address</h3>
                  <p>${this._escapeHtml(lead.address || 'N/A')}</p>
                </div>

                <div class="cover-section">
                  <h3>Project Timeline</h3>
                  <p>
                    ${startDate || 'N/A'} to ${endDate || 'N/A'}
                  </p>
                </div>

                <div class="cover-section">
                  <h3>Property Owner</h3>
                  <p>${this._escapeHtml(lead.name || 'N/A')}</p>
                </div>
              </div>

              <div class="cover-footer">
                <p>${this._escapeHtml(BRAND.phone)} | ${this._escapeHtml(BRAND.email)}</p>
              </div>
            </div>

            <!-- PROJECT SUMMARY -->
            <div class="page">
              <h1>Project Summary</h1>

              <table class="info-table">
                <tr>
                  <td><strong>Property Address:</strong></td>
                  <td>${this._escapeHtml(lead.address || 'N/A')}</td>
                </tr>
                <tr>
                  <td><strong>Owner:</strong></td>
                  <td>${this._escapeHtml(lead.name || 'N/A')}</td>
                </tr>
                <tr>
                  <td><strong>Start Date:</strong></td>
                  <td>${startDate || 'N/A'}</td>
                </tr>
                <tr>
                  <td><strong>Completion Date:</strong></td>
                  <td>${endDate || 'N/A'}</td>
                </tr>
                ${crewInfo ? `
                <tr>
                  <td><strong>Crew Information:</strong></td>
                  <td>${this._escapeHtml(crewInfo)}</td>
                </tr>
                ` : ''}
              </table>
            </div>

            <!-- MATERIALS USED -->
            ${materials && Object.keys(materials).length > 0 ? `
            <div class="page">
              <h1>Materials Used</h1>

              <table class="info-table">
                ${materials.manufacturer ? `
                <tr>
                  <td><strong>Manufacturer:</strong></td>
                  <td>${this._escapeHtml(materials.manufacturer)}</td>
                </tr>
                ` : ''}
                ${materials.productLine ? `
                <tr>
                  <td><strong>Product Line:</strong></td>
                  <td>${this._escapeHtml(materials.productLine)}</td>
                </tr>
                ` : ''}
                ${materials.color ? `
                <tr>
                  <td><strong>Color:</strong></td>
                  <td>${this._escapeHtml(materials.color)}</td>
                </tr>
                ` : ''}
                ${materials.warranty ? `
                <tr>
                  <td><strong>Warranty:</strong></td>
                  <td>${this._escapeHtml(materials.warranty)}</td>
                </tr>
                ` : ''}
              </table>
            </div>
            ` : ''}

            <!-- BEFORE/AFTER PHOTOS -->
            ${data.beforeAfterPhotos && data.beforeAfterPhotos.length > 0 ? `
            <div class="page">
              <h1>Before &amp; After Comparison</h1>
              <div class="before-after-grid">
                ${data.beforeAfterPhotos.map(pair => `
                  <div class="photo-pair">
                    ${pair.before ? `
                    <div class="photo-item">
                      <img src="${this._escapeHtml(pair.before.url)}" alt="Before">
                      <p class="photo-caption"><strong>Before</strong></p>
                    </div>
                    ` : ''}
                    ${pair.after ? `
                    <div class="photo-item">
                      <img src="${this._escapeHtml(pair.after.url)}" alt="After">
                      <p class="photo-caption"><strong>After</strong></p>
                    </div>
                    ` : ''}
                  </div>
                `).join('')}
              </div>
            </div>
            ` : ''}

            <!-- WORK COMPLETED CHECKLIST -->
            <div class="page">
              <h1>Work Completed Checklist</h1>

              <table class="checklist-table">
                <thead>
                  <tr>
                    <th>Work Item</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  ${COMPLETION_WORK_ITEMS.map(item => {
                    const status = workCompleted[item];
                    return `
                      <tr>
                        <td>${item}</td>
                        <td>
                          ${status === 'complete' ? '✓ Completed' : status === 'na' ? 'N/A' : '— Not recorded'}
                        </td>
                      </tr>
                    `;
                  }).join('')}
                </tbody>
              </table>
            </div>

            <!-- WARRANTY INFORMATION -->
            ${warrantyInfo && Object.keys(warrantyInfo).length > 0 ? `
            <div class="page">
              <h1>Warranty Information</h1>

              <table class="info-table">
                ${warrantyInfo.materialWarranty ? `
                <tr>
                  <td><strong>Material Warranty:</strong></td>
                  <td>${this._escapeHtml(warrantyInfo.materialWarranty)}</td>
                </tr>
                ` : ''}
                ${warrantyInfo.laborWarranty ? `
                <tr>
                  <td><strong>Labor Warranty:</strong></td>
                  <td>${this._escapeHtml(warrantyInfo.laborWarranty)}</td>
                </tr>
                ` : ''}
                ${warrantyInfo.registrationNumber ? `
                <tr>
                  <td><strong>Registration Number:</strong></td>
                  <td>${this._escapeHtml(warrantyInfo.registrationNumber)}</td>
                </tr>
                ` : ''}
              </table>
            </div>
            ` : ''}

            <!-- POST-INSTALL CARE TIPS -->
            ${maintenanceTips ? `
            <div class="page">
              <h1>Post-Installation Care Tips</h1>
              <p>${this._escapeHtml(maintenanceTips)}</p>
            </div>
            ` : ''}

            <!-- CUSTOMER SIGN-OFF -->
            <div class="page">
              <h1>Project Sign-Off</h1>

              <div style="margin-top: 30px;">
                <p style="margin-bottom: 20px;">
                  <strong>I certify that all work described in this report has been completed to my satisfaction.</strong>
                </p>

                <p style="margin-bottom: 5px;"><strong>Property Owner:</strong></p>
                <p style="margin-bottom: 30px;">Name: _____________________________ Signature: _______________</p>

                <p style="margin-bottom: 5px;"><strong>Project Manager:</strong></p>
                <p style="margin-bottom: 30px;">Name: ${this._escapeHtml(inspectorName || '___________________________')} Signature: _______________</p>

                <p><strong>Date:</strong> _______________</p>
              </div>
            </div>
          </div>
        </body>
        </html>
      `;

      return html;
    },

    /**
     * Render a damage assessment section (helper for storm damage)
     */
    _renderDamageSection(title, damageData) {
      if (!damageData || Object.keys(damageData).length === 0) return '';

      return `
        <h2>${title}</h2>
        <table class="damage-table">
          <tr>
            <td><strong>Damage Found:</strong></td>
            <td>${damageData.found ? 'Yes' : 'No'}</td>
          </tr>
          ${damageData.severity ? `
          <tr>
            <td><strong>Severity:</strong></td>
            <td>${damageData.severity}</td>
          </tr>
          ` : ''}
          ${damageData.notes ? `
          <tr>
            <td><strong>Notes:</strong></td>
            <td>${this._escapeHtml(damageData.notes)}</td>
          </tr>
          ` : ''}
        </table>
      `;
    },

    /**
     * Get print-optimized CSS
     */
    _getPrintStyles() {
      return `
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }

        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
          font-size: 11pt;
          line-height: 1.6;
          color: #333;
          background: white;
        }

        .report-container {
          width: 8.5in;
          height: 11in;
          margin: auto;
        }

        .page {
          width: 8.5in;
          height: 11in;
          padding: 0.5in;
          page-break-after: always;
          display: flex;
          flex-direction: column;
          border: 1px solid #ddd;
          background: white;
          overflow: hidden;
        }

        .cover-page {
          display: flex;
          flex-direction: column;
          justify-content: space-between;
          padding: 1in;
          background: linear-gradient(135deg, ${BRAND.colors.navy} 0%, #2c4a8d 100%);
          color: white;
        }

        .cover-header {
          text-align: center;
          margin-bottom: 40px;
        }

        .brand-logo {
          margin-bottom: 20px;
        }

        .cover-title {
          font-size: 32pt;
          font-weight: bold;
          color: white;
          margin-bottom: 20px;
        }

        .cover-content {
          flex: 1;
          display: flex;
          flex-direction: column;
          justify-content: center;
        }

        .cover-section {
          margin-bottom: 30px;
          background: rgba(255,255,255,0.1);
          padding: 15px;
          border-radius: 5px;
        }

        .cover-section h3 {
          font-size: 11pt;
          margin-bottom: 8px;
          opacity: 0.9;
        }

        .cover-section p {
          font-size: 14pt;
          font-weight: 500;
        }

        .cover-footer {
          text-align: center;
          font-size: 10pt;
          opacity: 0.9;
          padding-top: 20px;
          border-top: 1px solid rgba(255,255,255,0.2);
        }

        h1 {
          font-size: 18pt;
          margin-bottom: 15px;
          color: ${BRAND.colors.navy};
          border-bottom: 2px solid ${BRAND.colors.orange};
          padding-bottom: 8px;
        }

        h2 {
          font-size: 13pt;
          margin-top: 20px;
          margin-bottom: 10px;
          color: ${BRAND.colors.navy};
        }

        h3 {
          font-size: 11pt;
          margin-bottom: 8px;
          color: #555;
        }

        p {
          margin-bottom: 10px;
          text-align: justify;
        }

        .info-table, .checklist-table, .work-table, .damage-table {
          width: 100%;
          border-collapse: collapse;
          margin-bottom: 15px;
          font-size: 10pt;
        }

        .info-table td, .damage-table td {
          border-bottom: 1px solid #e0e0e0;
          padding: 8px 12px;
        }

        .info-table tr:nth-child(even),
        .damage-table tr:nth-child(even) {
          background: #f9f9f9;
        }

        .checklist-table th, .work-table th {
          background: ${BRAND.colors.navy};
          color: white;
          padding: 10px 12px;
          text-align: left;
          font-weight: 600;
          font-size: 10pt;
        }

        .checklist-table td, .work-table td {
          border-bottom: 1px solid #e0e0e0;
          padding: 8px 12px;
        }

        .checklist-table tr:nth-child(even),
        .work-table tr:nth-child(even) {
          background: #f9f9f9;
        }

        .condition-badge {
          display: inline-block;
          padding: 4px 10px;
          border-radius: 12px;
          font-size: 9pt;
          font-weight: 600;
          text-transform: uppercase;
        }

        .condition-good {
          background: #d4edda;
          color: #155724;
        }

        .condition-fair {
          background: #fff3cd;
          color: #856404;
        }

        .condition-poor {
          background: #f8d7da;
          color: #721c24;
        }

        .condition-critical {
          background: #f5c6cb;
          color: #721c24;
          font-weight: bold;
        }

        .condition-unknown {
          background: #e2e3e5;
          color: #383d41;
        }

        .photo-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 15px;
          margin-bottom: 15px;
        }

        .photo-item {
          text-align: center;
        }

        .photo-item img {
          max-width: 100%;
          height: auto;
          max-height: 300px;
          border: 1px solid #ddd;
          border-radius: 4px;
        }

        .photo-caption {
          font-size: 9pt;
          margin-top: 5px;
          color: #666;
          font-style: italic;
        }

        .before-after-grid {
          display: grid;
          grid-template-columns: 1fr;
          gap: 20px;
        }

        .photo-pair {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 15px;
        }

        hr {
          border: none;
          border-top: 1px solid #ddd;
          margin: 20px 0;
        }

        ul {
          margin-left: 20px;
          margin-bottom: 15px;
        }

        li {
          margin-bottom: 8px;
        }

        @media print {
          body {
            margin: 0;
            padding: 0;
          }
          .report-container {
            margin: 0;
            border: none;
          }
          .page {
            border: none;
            box-shadow: none;
          }
        }
      `;
    },

    /**
     * Open the report builder UI
     */
    async openBuilder(containerId, leadId, templateId) {
      const container = document.getElementById(containerId);
      if (!container) {
        console.error('Container not found:', containerId);
        return;
      }

      const lead = this._getLead(leadId);
      if (!lead) {
        showToast('Lead not found', 'error');
        return;
      }

      // Initialize wizard state
      const state = {
        leadId,
        templateId: templateId || null,
        currentStep: 0,
        data: this._loadDraft(leadId) || {},
        photos: []
      };

      // Render the wizard interface
      container.innerHTML = this._renderBuilderUI(state);

      // Attach event listeners
      this._attachBuilderListeners(container, state, lead);
    },

    /**
     * Render the wizard UI
     */
    _renderBuilderUI(state) {
      return `
        <div class="report-builder">
          <style>
            ${this._getBuilderStyles()}
          </style>

          <div class="builder-header">
            <h2>Create Inspection Report</h2>
            <p>Step ${state.currentStep + 1} of 5</p>
          </div>

          <div class="builder-progress">
            <div class="progress-bar" style="width: ${((state.currentStep + 1) / 5) * 100}%"></div>
          </div>

          <div class="builder-content" id="builder-content">
            ${this._renderBuilderStep(state)}
          </div>

          <div class="builder-footer">
            <button class="btn-secondary" id="btn-prev" style="display: ${state.currentStep === 0 ? 'none' : 'inline-block'};">
              ← Previous
            </button>
            <button class="btn-primary" id="btn-next">
              ${state.currentStep === 4 ? 'Generate Report' : 'Next →'}
            </button>
          </div>
        </div>
      `;
    },

    /**
     * Render current step
     */
    _renderBuilderStep(state) {
      const step = state.currentStep;

      if (step === 0) {
        return this._renderTemplateSelection(state);
      } else if (step === 1) {
        return this._renderPropertyInfo(state);
      } else if (step === 2) {
        return this._renderInspectionDetails(state);
      } else if (step === 3) {
        return this._renderPhotoSelection(state);
      } else if (step === 4) {
        return this._renderPreviewAndGenerate(state);
      }

      return '';
    },

    /**
     * Render template selection
     */
    _renderTemplateSelection(state) {
      const templates = this.getTemplates();

      return `
        <div class="step-content">
          <h3>Choose a Report Template</h3>
          <div class="template-grid">
            ${templates.map(template => `
              <div class="template-card ${state.templateId === template.id ? 'selected' : ''}"
                   data-template="${template.id}">
                <div class="template-icon">${template.icon}</div>
                <h4>${template.name}</h4>
                <p>${template.description}</p>
              </div>
            `).join('')}
          </div>

          <div id="saved-reports-list" style="margin-top: 30px;"></div>
        </div>
      `;
    },

    /**
     * INSP-1: populate the step-0 "saved reports" panel (async — getReports
     * hits Firestore). Binds View / Delete on the rows it renders.
     */
    async _renderSavedReportsInto(container, state, lead) {
      const host = container.querySelector('#saved-reports-list');
      if (!host) return;

      const reports = await this.getReports(state.leadId);
      if (!reports.length) {
        host.innerHTML = '';
        return;
      }

      host.innerHTML = `
        <h3 style="margin-bottom: 12px;">Saved Reports (${reports.length})</h3>
        <div style="display: grid; gap: 10px;">
          ${reports.map(report => `
            <div style="border: 1px solid #ddd; border-radius: 4px; padding: 12px; display: flex; justify-content: space-between; align-items: center;">
              <div>
                <strong style="color: ${BRAND.colors.navy};">${this._escapeHtml(report.type || 'Report')}</strong>
                <div style="font-size: 12px; color: #666;">
                  ${this._escapeHtml(report.metadata?.inspectorName || '')}
                  ${report.createdAt ? '· ' + new Date(report.createdAt?.toDate?.() || report.createdAt).toLocaleDateString() : ''}
                </div>
              </div>
              <div style="display: flex; gap: 8px;">
                <button type="button" class="btn-open-report" data-report-id="${this._escapeHtml(report.id)}" style="padding: 6px 14px; background: ${BRAND.colors.orange}; color: white; border: none; border-radius: 3px; cursor: pointer;">View</button>
                <button type="button" class="btn-share-report" data-report-id="${this._escapeHtml(report.id)}" style="padding: 6px 14px; background: #1A3057; color: white; border: none; border-radius: 3px; cursor: pointer;">Share</button>
                <button type="button" class="btn-delete-report" data-report-id="${this._escapeHtml(report.id)}" style="padding: 6px 14px; background: #eee; color: #333; border: none; border-radius: 3px; cursor: pointer;">Delete</button>
              </div>
            </div>
          `).join('')}
        </div>
      `;

      host.querySelectorAll('.btn-open-report').forEach(btn => {
        btn.addEventListener('click', (e) => this._openReport(e.currentTarget.dataset.reportId));
      });
      host.querySelectorAll('.btn-share-report').forEach(btn => {
        btn.addEventListener('click', (e) => this._shareReport(e.currentTarget.dataset.reportId));
      });
      host.querySelectorAll('.btn-delete-report').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          const _ask = window.nbdConfirm || ((m) => Promise.resolve(window.confirm(m)));
          if (await _ask('Delete this report?')) {
            await this.deleteReport(e.currentTarget.dataset.reportId);
            this._renderSavedReportsInto(container, state, lead);
          }
        });
      });
    },

    /**
     * Render property info step
     */
    _renderPropertyInfo(state) {
      const lead = this._getLead(state.leadId);

      return `
        <div class="step-content">
          <h3>Property Information</h3>
          <form id="property-form">
            <div class="form-group">
              <label>Property Address</label>
              <input type="text" name="address" value="${this._escapeHtml(lead?.address || '')}" required>
            </div>
            <div class="form-group">
              <label>Owner Name</label>
              <input type="text" name="ownerName" value="${this._escapeHtml(lead?.name || '')}" required>
            </div>
            <div class="form-group">
              <label>Phone</label>
              <input type="tel" name="phone" value="${this._escapeHtml(lead?.phone || '')}">
            </div>
            <div class="form-group">
              <label>Email</label>
              <input type="email" name="email" value="${this._escapeHtml(lead?.email || '')}">
            </div>
            <div class="form-group">
              <label>Inspector Name</label>
              <input type="text" name="inspectorName" value="${this._escapeHtml(state.data.inspectorName || window._user?.displayName || '')}" required>
            </div>
            <div class="form-group">
              <label>Inspection Date</label>
              <input type="date" name="inspectionDate" value="${state.data.inspectionDate || new Date().toISOString().split('T')[0]}" required>
            </div>
          </form>
        </div>
      `;
    },

    /**
     * Render inspection details step (varies by template)
     */
    _renderInspectionDetails(state) {
      const templateId = state.templateId;

      if (templateId === 'full-inspection') {
        return this._renderFullInspectionDetails(state);
      } else if (templateId === 'storm-damage') {
        return this._renderStormDamageDetails(state);
      } else if (templateId === 'supplement') {
        return this._renderSupplementDetails(state);
      } else if (templateId === 'completion') {
        return this._renderCompletionDetails(state);
      }

      return '';
    },

    /**
     * Render full inspection details
     */
    _renderFullInspectionDetails(state) {
      const { roofType = '', roofAge = '', totalSquares = '', slopes = '' } = state.data;

      return `
        <div class="step-content">
          <h3>Roof Information</h3>
          <form id="details-form">
            <div class="form-group">
              <label>Roof Type</label>
              <input type="text" name="roofType" value="${this._escapeHtml(roofType)}" placeholder="e.g., Asphalt Shingle">
            </div>
            <div class="form-group">
              <label>Approximate Age (years)</label>
              <input type="number" name="roofAge" value="${roofAge}" min="0">
            </div>
            <div class="form-group">
              <label>Total Squares</label>
              <input type="number" name="totalSquares" value="${totalSquares}" step="0.1" placeholder="e.g., 35.5">
            </div>
            <div class="form-group">
              <label>Number of Slopes</label>
              <input type="number" name="slopes" value="${slopes}" min="1">
            </div>
          </form>

          <h3 style="margin-top: 30px;">Damage Assessment (Optional)</h3>
          <form id="damage-form">
            <div class="form-group">
              <label>Damage Type</label>
              <input type="text" name="damageType" value="${this._escapeHtml(state.data.damageAssessment?.type || '')}" placeholder="e.g., Hail damage">
            </div>
            <div class="form-group">
              <label>Severity (1-5)</label>
              <select name="severity">
                <option value="">Select...</option>
                ${[1,2,3,4,5].map(n => `<option value="${n}" ${state.data.damageAssessment?.severity === n ? 'selected' : ''}>${n}</option>`).join('')}
              </select>
            </div>
            <div class="form-group">
              <label>Affected Area (sq ft)</label>
              <input type="number" name="area" value="${state.data.damageAssessment?.area || ''}" step="0.1">
            </div>
            <div class="form-group">
              <label>Location on Roof</label>
              <input type="text" name="location" value="${this._escapeHtml(state.data.damageAssessment?.location || '')}" placeholder="e.g., North side">
            </div>
            <div class="form-group">
              <label>Description</label>
              <textarea name="description" rows="4" placeholder="Detailed description of damage...">${this._escapeHtml(state.data.damageAssessment?.description || '')}</textarea>
            </div>
          </form>

          <h3 style="margin-top: 30px;">Recommendations</h3>
          <form id="recommendations-form">
            <div class="form-group">
              <label>Recommended Action</label>
              <textarea name="recommendations" rows="4" placeholder="Repair vs replace recommendation with reasoning...">${this._escapeHtml(state.data.recommendations || '')}</textarea>
            </div>
          </form>

          <h3 style="margin-top: 30px;">Roof Components Checklist</h3>
          <p style="font-size:12px;color:#666;margin-bottom:10px;">Rate each component you inspected. Leave the condition blank to omit a component from the report.</p>
          <div id="components-checklist">
            ${ROOF_COMPONENTS.map(comp => {
              const c = (state.data.components && state.data.components[comp]) || {};
              return `
                <div class="comp-row" data-comp="${this._escapeHtml(comp)}">
                  <span class="comp-name">${this._escapeHtml(comp)}</span>
                  <select class="comp-condition">
                    <option value="">—</option>
                    ${CONDITIONS.map(cond => `<option value="${cond}" ${c.condition === cond ? 'selected' : ''}>${cond}</option>`).join('')}
                  </select>
                  <input type="text" class="comp-notes" placeholder="Notes (optional)" value="${this._escapeHtml(c.notes || '')}">
                </div>
              `;
            }).join('')}
          </div>

          <h3 style="margin-top: 30px;">Estimated Scope of Work (optional)</h3>
          <p style="font-size:12px;color:#666;margin-bottom:10px;">Items recommended for repair or replacement. Area &amp; severity fill the inspection report's scope table; the costs total into its "Estimated total scope value".</p>
          <div style="display:grid;grid-template-columns:1.1fr 1.8fr 0.95fr 0.8fr 0.95fr 28px;gap:6px;font-size:11px;color:#888;margin-bottom:4px;">
            <span>Area</span><span>Item / description</span><span>Severity</span><span>Qty</span><span>Cost&nbsp;$</span><span></span>
          </div>
          <div id="scope-items-container">
            ${(state.data.estimatedWork || []).map((item, idx) => this._renderScopeRow(item, idx)).join('')}
          </div>
          <button type="button" id="btn-add-scope" class="btn-secondary" style="margin-top: 10px;">+ Add Scope Item</button>
        </div>
      `;
    },

    /**
     * One scope-of-work row. Canonical fields are
     * {area, description, severity, quantity, cost, notes}; legacy drafts
     * (the old Description/Qty/Unit/Total form) are read via aliases
     * (item→description, qty→quantity, total→cost; unit is dropped) so
     * they still round-trip on re-render. Notes sits on its own full-width
     * line and surfaces as a sub-line under the item on the report.
     */
    _renderScopeRow(item, idx) {
      item = item || {};
      const qty  = item.quantity != null ? item.quantity : (item.qty != null ? item.qty : '');
      const cost = item.cost != null ? item.cost : (item.total != null ? item.total : '');
      const sev  = item.severity || '';
      return `
        <div class="scope-item" data-index="${idx}" style="border:1px solid #eee;border-radius:5px;padding:6px;margin-bottom:6px;">
          <div style="display:grid;grid-template-columns:1.1fr 1.8fr 0.95fr 0.8fr 0.95fr 28px;gap:6px;align-items:center;">
            <input type="text" placeholder="Area" value="${this._escapeHtml(item.area || '')}" class="scope-area">
            <input type="text" placeholder="Item / description" value="${this._escapeHtml(item.description || item.item || '')}" class="scope-description">
            <select class="scope-severity">
              <option value="">Severity…</option>
              ${CONDITIONS.map(c => `<option value="${c}" ${sev === c ? 'selected' : ''}>${c}</option>`).join('')}
            </select>
            <input type="text" placeholder="Qty" value="${this._escapeHtml(String(qty))}" class="scope-quantity">
            <input type="number" placeholder="Cost $" value="${cost !== '' ? Number(cost) : ''}" class="scope-cost" step="0.01" min="0">
            <button type="button" class="btn-remove-scope" title="Remove item" style="background:none;border:none;color:#c00;font-size:18px;cursor:pointer;line-height:1;">×</button>
          </div>
          <input type="text" placeholder="Notes (optional — shown under the item on the report)" value="${this._escapeHtml(item.notes || '')}" class="scope-notes" style="width:100%;margin-top:5px;">
        </div>
      `;
    },

    /**
     * Render storm damage details
     */
    _renderStormDamageDetails(state) {
      const { stormDate = '', stormType = '', hailSize = '', windSpeed = '' } = state.data;

      return `
        <div class="step-content">
          <h3>Storm Event Information</h3>
          <form id="details-form">
            <div class="form-group">
              <label>Date of Storm</label>
              <input type="date" name="stormDate" value="${stormDate}">
            </div>
            <div class="form-group">
              <label>Storm Type</label>
              <select name="stormType">
                <option value="">Select...</option>
                <option value="Hail" ${stormType === 'Hail' ? 'selected' : ''}>Hail</option>
                <option value="Wind" ${stormType === 'Wind' ? 'selected' : ''}>Wind</option>
                <option value="Tornado" ${stormType === 'Tornado' ? 'selected' : ''}>Tornado</option>
                <option value="Heavy Rain" ${stormType === 'Heavy Rain' ? 'selected' : ''}>Heavy Rain</option>
              </select>
            </div>
            <div class="form-group">
              <label>Hail Size (if applicable)</label>
              <input type="text" name="hailSize" value="${this._escapeHtml(hailSize)}" placeholder="e.g., 1.5 inch">
            </div>
            <div class="form-group">
              <label>Wind Speed (if known)</label>
              <input type="text" name="windSpeed" value="${this._escapeHtml(windSpeed)}" placeholder="e.g., 75 mph">
            </div>
          </form>

          <h3 style="margin-top: 30px;">Exterior Damage Summary</h3>
          <form id="damage-summary">
            ${[
              ['roof', 'Roof'], ['siding', 'Siding'],
              ['gutter', 'Gutters & Downspouts'], ['window', 'Windows'], ['screen', 'Screens']
            ].map(([key, label]) => {
              const dd = (state.data[key + 'Damage']) || {};
              return `
                <div class="damage-section">
                  <h4>${label} Damage</h4>
                  <label><input type="checkbox" name="${key}DamageFound" ${dd.found ? 'checked' : ''}> Damage Found</label>
                  <select name="${key}Severity" style="width:100%;margin-top:8px;">
                    <option value="">Severity…</option>
                    ${SEVERITY_LEVELS.map(n => `<option value="${n}" ${String(dd.severity) === String(n) ? 'selected' : ''}>${n}</option>`).join('')}
                  </select>
                  <input type="text" name="${key}Notes" value="${this._escapeHtml(dd.notes || '')}" placeholder="Notes" style="width: 100%; margin-top: 8px;">
                </div>
              `;
            }).join('')}
          </form>

          <h3 style="margin-top: 30px;">Test Square (optional)</h3>
          <form id="testsquare-form">
            <div class="form-group"><label>Location</label><input type="text" name="testSquareLocation" value="${this._escapeHtml(state.data.testSquare?.location || '')}" placeholder="e.g., South slope"></div>
            <div class="form-group"><label>Dimensions</label><input type="text" name="testSquareDimensions" value="${this._escapeHtml(state.data.testSquare?.dimensions || '')}" placeholder="e.g., 10ft x 10ft"></div>
            <div class="form-group"><label>Hits Counted</label><input type="number" name="testSquareHits" value="${state.data.testSquare?.hits || ''}" min="0"></div>
            <div class="form-group"><label>Measurements / Notes</label><input type="text" name="testSquareMeasurements" value="${this._escapeHtml(state.data.testSquare?.measurements || '')}"></div>
          </form>

          <h3 style="margin-top: 30px;">Interior Damage (optional)</h3>
          <form id="interior-form">
            <div class="form-group"><label>Water Stains</label><input type="text" name="interiorWaterStains" value="${this._escapeHtml(state.data.interiorDamage?.waterStains || '')}" placeholder="Location / extent"></div>
            <div class="form-group"><label>Active Leaks</label><input type="text" name="interiorActiveLeaks" value="${this._escapeHtml(state.data.interiorDamage?.activeLeaks || '')}"></div>
            <div class="form-group"><label>Attic Observations</label><input type="text" name="interiorAtticObservations" value="${this._escapeHtml(state.data.interiorDamage?.atticObservations || '')}"></div>
          </form>

          <h3 style="margin-top: 30px;">Collateral Damage (optional)</h3>
          <form id="collateral-form">
            ${[['acUnits','AC Units'],['vents','Vents'],['mailbox','Mailbox'],['fencing','Fencing'],['vehicles','Vehicles'],['landscaping','Landscaping']].map(([k,l]) =>
              `<div class="form-group"><label>${l}</label><input type="text" name="collateral_${k}" value="${this._escapeHtml(state.data.collateralDamage?.[k] || '')}"></div>`
            ).join('')}
          </form>

          <h3 style="margin-top: 30px;">Insurance Recommendation</h3>
          <form id="storm-rec-form">
            <div class="form-group"><label><input type="checkbox" name="recFileClaim" ${state.data.recommendations?.fileClaim ? 'checked' : ''}> Recommend filing an insurance claim</label></div>
            <div class="form-group"><label>Estimated Scope</label><textarea name="recEstimatedScope" rows="3">${this._escapeHtml(state.data.recommendations?.estimatedScope || '')}</textarea></div>
            <div class="form-group"><label>Recommended Next Steps</label><textarea name="recNextSteps" rows="3">${this._escapeHtml(state.data.recommendations?.nextSteps || '')}</textarea></div>
            <div class="form-group"><label>Inspector Notes</label><textarea name="stormNotes" rows="3">${this._escapeHtml(state.data.notes || '')}</textarea></div>
          </form>
        </div>
      `;
    },

    /**
     * Render supplement details
     */
    _renderSupplementDetails(state) {
      const lead = this._getLead(state.leadId);

      return `
        <div class="step-content">
          <h3>Supplement Information</h3>
          <form id="details-form">
            <div class="form-group">
              <label>Claim Number</label>
              <input type="text" name="claimNumber" value="${this._escapeHtml(lead?.claimNumber || state.data.claimNumber || '')}" required>
            </div>
            <div class="form-group">
              <label>Policy Number</label>
              <input type="text" name="policyNumber" value="${this._escapeHtml(lead?.policyNumber || state.data.policyNumber || '')}">
            </div>
            <div class="form-group">
              <label>Notes/Explanation</label>
              <textarea name="notes" rows="4" placeholder="Why these items were missed or are now necessary...">${this._escapeHtml(state.data.notes || '')}</textarea>
            </div>
          </form>

          <h3 style="margin-top: 30px;">Add Supplemental Line Items</h3>
          <div id="supplemental-items-container">
            ${(state.data.supplementalItems || []).map((item, idx) => `
              <div class="line-item" data-index="${idx}">
                <input type="text" placeholder="Description" value="${this._escapeHtml(item.description || '')}" class="item-description">
                <input type="text" placeholder="Xact Code" value="${this._escapeHtml(item.xactCode || '')}" class="item-code">
                <input type="number" placeholder="Qty" value="${item.quantity || ''}" class="item-qty" step="0.01">
                <input type="number" placeholder="Unit Cost" value="${item.unitCost || ''}" class="item-cost" step="0.01">
                <input type="text" placeholder="Reason" value="${this._escapeHtml(item.reason || '')}" class="item-reason">
                <button type="button" class="btn-remove-item">×</button>
              </div>
            `).join('')}
          </div>
          <button type="button" id="btn-add-item" class="btn-secondary" style="margin-top: 10px;">+ Add Item</button>
        </div>
      `;
    },

    /**
     * Render completion details
     */
    _renderCompletionDetails(state) {
      return `
        <div class="step-content">
          <h3>Project Information</h3>
          <form id="details-form">
            <div class="form-group">
              <label>Start Date</label>
              <input type="date" name="startDate" value="${state.data.startDate || ''}">
            </div>
            <div class="form-group">
              <label>Completion Date</label>
              <input type="date" name="endDate" value="${state.data.endDate || ''}">
            </div>
            <div class="form-group">
              <label>Crew Information</label>
              <textarea name="crewInfo" rows="3" placeholder="Names and roles of crew members...">${this._escapeHtml(state.data.crewInfo || '')}</textarea>
            </div>
          </form>

          <h3 style="margin-top: 30px;">Materials Used</h3>
          <form id="materials-form">
            <div class="form-group">
              <label>Manufacturer</label>
              <input type="text" name="manufacturer" value="${this._escapeHtml(state.data.materials?.manufacturer || '')}">
            </div>
            <div class="form-group">
              <label>Product Line</label>
              <input type="text" name="productLine" value="${this._escapeHtml(state.data.materials?.productLine || '')}">
            </div>
            <div class="form-group">
              <label>Color</label>
              <input type="text" name="color" value="${this._escapeHtml(state.data.materials?.color || '')}">
            </div>
            <div class="form-group">
              <label>Material Warranty</label>
              <input type="text" name="materialWarranty" value="${this._escapeHtml(state.data.warrantyInfo?.materialWarranty || '')}" placeholder="e.g., 25-year">
            </div>
            <div class="form-group">
              <label>Labor Warranty</label>
              <input type="text" name="laborWarranty" value="${this._escapeHtml(state.data.warrantyInfo?.laborWarranty || '')}" placeholder="e.g., 5-year">
            </div>
            <div class="form-group">
              <label>Warranty Registration Number</label>
              <input type="text" name="registrationNumber" value="${this._escapeHtml(state.data.warrantyInfo?.registrationNumber || '')}">
            </div>
          </form>

          <h3 style="margin-top: 30px;">Work Completed Checklist</h3>
          <div id="work-completed-checklist">
            ${COMPLETION_WORK_ITEMS.map(item => {
              const status = (state.data.workCompleted && state.data.workCompleted[item]) || '';
              return `
                <div class="comp-row" data-work="${this._escapeHtml(item)}">
                  <span class="comp-name">${this._escapeHtml(item)}</span>
                  <select class="work-status">
                    <option value="" ${status === '' ? 'selected' : ''}>— Not recorded</option>
                    <option value="complete" ${status === 'complete' ? 'selected' : ''}>✓ Completed</option>
                    <option value="na" ${status === 'na' ? 'selected' : ''}>N/A</option>
                  </select>
                </div>
              `;
            }).join('')}
          </div>

          <h3 style="margin-top: 30px;">Post-Installation Care Tips</h3>
          <form id="care-form">
            <div class="form-group">
              <label>Maintenance Recommendations</label>
              <textarea name="maintenanceTips" rows="4" placeholder="Tips for ongoing maintenance...">${this._escapeHtml(state.data.maintenanceTips || '')}</textarea>
            </div>
          </form>
        </div>
      `;
    },

    /**
     * Render photo selection step
     */
    _renderPhotoSelection(state) {
      return `
        <div class="step-content">
          <h3>Select Photos for Report</h3>
          <p>Choose photos to include in your report. You can drag to reorder.</p>

          <div id="photo-preview" class="photo-preview-grid">
            <!-- Photos will be loaded here -->
          </div>

          <div style="margin-top: 20px; padding: 15px; background: #f0f0f0; border-radius: 4px;">
            <p style="font-size: 12px; color: #666;">
              Photos tagged for this report will appear automatically.
              Additional photos from this lead can be selected below.
            </p>
          </div>
        </div>
      `;
    },

    /**
     * Render preview and generate step
     */
    _renderPreviewAndGenerate(state) {
      return `
        <div class="step-content">
          <h3>Review & Generate</h3>
          <p>Your report is ready to generate. Click the button below to create the report.</p>

          <div id="report-summary" style="background: #f9f9f9; padding: 15px; border-radius: 4px; margin-top: 20px;">
            <p><strong>Template:</strong> ${this._escapeHtml(this.getTemplate(state.templateId)?.name || '')}</p>
            <p><strong>Lead:</strong> ${this._escapeHtml(this._getLead(state.leadId)?.name || '')}</p>
            <p><strong>Inspector:</strong> ${this._escapeHtml(state.data.inspectorName || '')}</p>
          </div>

          <div style="margin-top: 20px;">
            <label><input type="checkbox" id="save-to-db"> Save report to database</label>
          </div>
        </div>
      `;
    },

    /**
     * Get builder CSS
     */
    _getBuilderStyles() {
      return `
        .report-builder {
          background: white;
          border-radius: 8px;
          box-shadow: 0 2px 8px rgba(0,0,0,0.1);
          overflow: hidden;
        }

        .builder-header {
          background: linear-gradient(135deg, ${BRAND.colors.navy}, #2c4a8d);
          color: white;
          padding: 20px;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .builder-header h2 {
          margin: 0;
          font-size: 20px;
        }

        .builder-header p {
          margin: 0;
          opacity: 0.9;
          font-size: 14px;
        }

        .builder-progress {
          height: 4px;
          background: #e0e0e0;
          position: relative;
        }

        .progress-bar {
          height: 100%;
          background: ${BRAND.colors.orange};
          transition: width 0.3s ease;
        }

        .builder-content {
          padding: 30px;
          min-height: 500px;
        }

        .step-content {
          max-width: 600px;
        }

        .step-content h3 {
          color: ${BRAND.colors.navy};
          margin-bottom: 20px;
          font-size: 16px;
        }

        .step-content h4 {
          font-size: 13px;
          color: #333;
          margin-top: 15px;
          margin-bottom: 10px;
        }

        .form-group {
          margin-bottom: 20px;
        }

        .form-group label {
          display: block;
          margin-bottom: 6px;
          font-weight: 500;
          color: #333;
          font-size: 13px;
        }

        .form-group input,
        .form-group textarea,
        .form-group select {
          width: 100%;
          padding: 10px;
          border: 1px solid #ddd;
          border-radius: 4px;
          font-family: inherit;
          font-size: 13px;
        }

        .form-group textarea {
          resize: vertical;
        }

        .template-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 20px;
          margin-top: 20px;
        }

        .template-card {
          border: 2px solid #e0e0e0;
          border-radius: 8px;
          padding: 20px;
          text-align: center;
          cursor: pointer;
          transition: all 0.2s ease;
        }

        .template-card:hover {
          border-color: ${BRAND.colors.orange};
          background: #f9f9f9;
        }

        .template-card.selected {
          border-color: ${BRAND.colors.navy};
          background: #f0f4ff;
        }

        .template-icon {
          font-size: 40px;
          margin-bottom: 10px;
        }

        .template-card h4 {
          margin: 10px 0 8px 0;
          color: ${BRAND.colors.navy};
        }

        .template-card p {
          margin: 0;
          font-size: 12px;
          color: #666;
        }

        .damage-section {
          margin-bottom: 20px;
          padding: 15px;
          background: #f9f9f9;
          border-radius: 4px;
        }

        .damage-section label {
          margin-bottom: 10px;
        }

        .damage-section input[type="checkbox"] {
          margin-right: 8px;
        }

        .line-item {
          display: grid;
          grid-template-columns: 2fr 1fr 1fr 1fr 1fr 40px;
          gap: 10px;
          margin-bottom: 10px;
          padding: 10px;
          background: #f9f9f9;
          border-radius: 4px;
          align-items: center;
        }
        /* Wave 28: line-item collapses to 2-col on phones so the 6-col
           grid (description / qty / unit / unit-price / total / delete)
           doesn't blow out 375px viewports. Label spans full width. */
        @media (max-width: 600px) {
          .line-item {
            grid-template-columns: 1fr 1fr 40px;
            gap: 6px;
            padding: 8px;
          }
          .line-item > :first-child {
            grid-column: 1 / -1;
          }
        }

        .line-item input {
          padding: 8px;
          border: 1px solid #ddd;
          border-radius: 3px;
          font-size: 12px;
        }

        .btn-remove-item {
          background: #ff4444;
          color: white;
          border: none;
          border-radius: 3px;
          cursor: pointer;
          padding: 8px;
          font-size: 16px;
          line-height: 1;
        }

        .btn-remove-item:hover {
          background: #cc0000;
        }

        .comp-row {
          display: grid;
          grid-template-columns: 1.4fr 1fr 1.6fr;
          gap: 10px;
          align-items: center;
          padding: 6px 0;
          border-bottom: 1px solid #f0f0f0;
        }
        .comp-row .comp-name {
          font-size: 13px;
          color: #333;
        }
        .comp-row select,
        .comp-row input {
          padding: 6px 8px;
          border: 1px solid #ddd;
          border-radius: 3px;
          font-size: 12px;
        }
        #work-completed-checklist .comp-row {
          grid-template-columns: 1.4fr 1fr;
        }
        @media (max-width: 600px) {
          .comp-row,
          #work-completed-checklist .comp-row {
            grid-template-columns: 1fr 1fr;
          }
          .comp-row .comp-name {
            grid-column: 1 / -1;
            font-weight: 600;
          }
        }

        .photo-preview-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
          gap: 15px;
          margin-top: 20px;
        }

        .photo-preview-item {
          position: relative;
          background: #f0f0f0;
          border-radius: 4px;
          overflow: hidden;
          aspect-ratio: 1;
          cursor: move;
        }

        .photo-preview-item img {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }

        .photo-preview-item.selected {
          border: 3px solid ${BRAND.colors.orange};
        }

        .builder-footer {
          padding: 20px 30px;
          background: #f9f9f9;
          border-top: 1px solid #e0e0e0;
          display: flex;
          justify-content: space-between;
          gap: 10px;
        }

        .btn-primary, .btn-secondary {
          padding: 12px 24px;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-size: 14px;
          font-weight: 500;
          transition: all 0.2s ease;
        }

        .btn-primary {
          background: ${BRAND.colors.orange};
          color: white;
        }

        .btn-primary:hover {
          background: #a83e13;
          box-shadow: 0 2px 8px rgba(0,0,0,0.2);
        }

        .btn-secondary {
          background: white;
          color: ${BRAND.colors.navy};
          border: 2px solid ${BRAND.colors.navy};
        }

        .btn-secondary:hover {
          background: ${BRAND.colors.navy};
          color: white;
        }
      `;
    },

    /**
     * Attach event listeners to builder (full re-render: binds nav + step)
     */
    _attachBuilderListeners(container, state, lead) {
      const nextBtn = container.querySelector('#btn-next');
      const prevBtn = container.querySelector('#btn-prev');

      nextBtn?.addEventListener('click', () => this._handleNextStep(container, state, lead));
      prevBtn?.addEventListener('click', () => this._handlePrevStep(container, state, lead));

      this._attachStepListeners(container, state, lead);
    },

    /**
     * Attach listeners specific to the current step. Safe to call again
     * after a content-only re-render — it does NOT rebind the footer nav.
     */
    _attachStepListeners(container, state, lead) {
      const step = state.currentStep;

      if (step === 0) {
        container.querySelectorAll('.template-card').forEach(card => {
          card.addEventListener('click', () => {
            container.querySelectorAll('.template-card').forEach(c => c.classList.remove('selected'));
            card.classList.add('selected');
            state.templateId = card.dataset.template;
          });
        });
        // INSP-1: surface saved reports (async — populates #saved-reports-list)
        this._renderSavedReportsInto(container, state, lead);
      }

      if (step === 2 && state.templateId === 'supplement') {
        container.querySelector('#btn-add-item')?.addEventListener('click', () => {
          this._collectCurrentStep(container, state);
          if (!Array.isArray(state.data.supplementalItems)) state.data.supplementalItems = [];
          state.data.supplementalItems.push({});
          this._refreshStep(container, state, lead);
        });
        container.querySelectorAll('#supplemental-items-container .btn-remove-item').forEach((btn, idx) => {
          btn.addEventListener('click', () => {
            this._collectCurrentStep(container, state);
            (state.data.supplementalItems || []).splice(idx, 1);
            this._refreshStep(container, state, lead);
          });
        });
      }

      if (step === 2 && state.templateId === 'full-inspection') {
        container.querySelector('#btn-add-scope')?.addEventListener('click', () => {
          this._collectCurrentStep(container, state);
          if (!Array.isArray(state.data.estimatedWork)) state.data.estimatedWork = [];
          state.data.estimatedWork.push({});
          this._refreshStep(container, state, lead);
        });
        container.querySelectorAll('#scope-items-container .btn-remove-scope').forEach((btn, idx) => {
          btn.addEventListener('click', () => {
            this._collectCurrentStep(container, state);
            (state.data.estimatedWork || []).splice(idx, 1);
            this._refreshStep(container, state, lead);
          });
        });
      }

      if (step === 3) {
        this._loadPhotosForSelection(container, state);
      }
    },

    /**
     * Re-render only the current step's content + re-bind step listeners,
     * leaving the footer nav (and its handlers) intact. Used by the
     * dynamic add/remove-row buttons.
     */
    _refreshStep(container, state, lead) {
      const contentEl = container.querySelector('#builder-content');
      if (!contentEl) {
        container.innerHTML = this._renderBuilderUI(state);
        this._attachBuilderListeners(container, state, lead);
        return;
      }
      contentEl.innerHTML = this._renderBuilderStep(state);
      this._attachStepListeners(container, state, lead);
    },

    /**
     * Load the lead's photos into the step-3 selection grid and let the
     * user toggle which ones go into the report. Selected photos are
     * stored on state.data.photos in the shape the templates expect
     * ({ url, description, aiAnalysis }).
     */
    _loadPhotosForSelection(container, state) {
      const grid = container.querySelector('#photo-preview');
      if (!grid) return;

      // window._photoCache, not PhotoEngine. PhotoEngine exports its
      // internal getPhotosForLead only as `getPhotosForReport`, so the old
      // `typeof ... === 'function'` guard here was ALWAYS false and this
      // pool was always [] — which is why this step printed "No photos found
      // for this lead" on leads that had photos. Renaming is not the fix:
      // getPhotosForLead is async (a Promise into synchronous code) and
      // queries userId-only, which would drop a teammate's photos from the
      // report. The cache is synchronous, lead-keyed, and filled from both
      // the userId and companyId scopes at dashboard boot.
      const pool = (window._photoCache && window._photoCache[state.leadId]) || [];

      if (!pool.length) {
        grid.innerHTML = '<p style="color:#666;font-size:13px;">No photos found for this lead. Add photos from the Photos tab to include them in the report.</p>';
        state.data.photos = [];
        return;
      }

      // Variants are named thumb/med/full (image-pipeline.js:105-109). `lg` and
      // `md` have never existed, so this always fell through to the original
      // camera upload — full sensor resolution, once per photo, inside the
      // renderer's 25s setContent budget. `full` is the 1600px print source.
      const urlOf = (p) => (p && p.urls && (p.urls.full || p.urls.med)) || (p && p.url) || '';
      const toReportPhoto = (p) => ({
        url: urlOf(p),
        // aiCaption is a phantom field — Claude Vision writes aiSuggestion.caption
        // (photo-vision.js). Read the real key so AI captions reach the report.
        description: p.caption || (p.aiSuggestion && p.aiSuggestion.caption) || p.aiCaption || p.description || '',
        aiAnalysis: p.aiAnalysis || null
      });

      // First visit: default-select all so reports aren't accidentally empty.
      if (!state._photosInitialized) {
        state._photosInitialized = true;
        state.data.photos = pool.map(toReportPhoto).filter(p => p.url);
      }
      const selectedUrls = new Set((state.data.photos || []).map(p => p.url));

      grid.innerHTML = pool.map((p, i) => {
        const url = urlOf(p);
        return `
          <div class="photo-preview-item ${selectedUrls.has(url) ? 'selected' : ''}" data-idx="${i}">
            <img src="${this._escapeHtml(url)}" alt="Lead photo">
          </div>`;
      }).join('');

      grid.querySelectorAll('.photo-preview-item').forEach(el => {
        el.addEventListener('click', () => {
          el.classList.toggle('selected');
          const chosen = [];
          grid.querySelectorAll('.photo-preview-item.selected').forEach(sel => {
            const p = pool[Number(sel.dataset.idx)];
            const rp = p && toReportPhoto(p);
            if (rp && rp.url) chosen.push(rp);
          });
          state.data.photos = chosen;
        });
      });
    },

    /**
     * Collect everything entered on the current step into state.data,
     * assembling the NESTED shapes the report templates and the server
     * payload expect (flat form names → nested objects). This is the fix
     * for the flat-vs-nested data-contract break.
     */
    _collectCurrentStep(container, state) {
      const d = state.data;

      // 1) Generic flat form fields (roofType, recommendations, dates, …)
      container.querySelectorAll('form').forEach(form => {
        const fd = new FormData(form);
        for (let [key, value] of fd.entries()) {
          d[key] = value;
        }
        // Unchecked checkboxes are omitted from FormData — capture them.
        form.querySelectorAll('input[type="checkbox"][name]').forEach(cb => {
          d[cb.name] = cb.checked;
        });
      });

      const step = state.currentStep;
      if (step !== 2) return;

      // 2) Full inspection: damageAssessment + components + scope
      if (state.templateId === 'full-inspection') {
        d.damageAssessment = {
          type: d.damageType || '',
          severity: d.severity ? Number(d.severity) : '',
          area: d.area || '',
          location: d.location || '',
          description: d.description || '',
          summary: d.description || ''
        };
        const components = {};
        container.querySelectorAll('#components-checklist .comp-row').forEach(row => {
          const name = row.dataset.comp;
          const condition = row.querySelector('.comp-condition')?.value || '';
          const notes = row.querySelector('.comp-notes')?.value || '';
          if (condition || notes) components[name] = { condition, notes };
        });
        d.components = components;
        const scope = [];
        container.querySelectorAll('#scope-items-container .scope-item').forEach(row => {
          const area = (row.querySelector('.scope-area')?.value || '').trim();
          const description = (row.querySelector('.scope-description')?.value || '').trim();
          const severity = row.querySelector('.scope-severity')?.value || '';
          const quantity = (row.querySelector('.scope-quantity')?.value || '').trim();
          const costRaw = row.querySelector('.scope-cost')?.value || '';
          const notes = (row.querySelector('.scope-notes')?.value || '').trim();
          if (area || description || severity || quantity || costRaw || notes) {
            const cost = costRaw === '' ? '' : Number(costRaw);
            scope.push({ area, description, severity, quantity, cost, notes });
          }
        });
        d.estimatedWork = scope;
      }

      // 3) Storm damage: nested damage sections + interior/collateral/test/rec
      if (state.templateId === 'storm-damage') {
        ['roof', 'siding', 'gutter', 'window', 'screen'].forEach(key => {
          d[key + 'Damage'] = {
            found: !!d[key + 'DamageFound'],
            severity: d[key + 'Severity'] || '',
            notes: d[key + 'Notes'] || ''
          };
        });
        d.testSquare = {
          location: d.testSquareLocation || '',
          dimensions: d.testSquareDimensions || '',
          hits: d.testSquareHits || '',
          measurements: d.testSquareMeasurements || ''
        };
        d.interiorDamage = {
          waterStains: d.interiorWaterStains || '',
          activeLeaks: d.interiorActiveLeaks || '',
          atticObservations: d.interiorAtticObservations || ''
        };
        d.collateralDamage = {
          acUnits: d.collateral_acUnits || '',
          vents: d.collateral_vents || '',
          mailbox: d.collateral_mailbox || '',
          fencing: d.collateral_fencing || '',
          vehicles: d.collateral_vehicles || '',
          landscaping: d.collateral_landscaping || ''
        };
        d.recommendations = {
          fileClaim: !!d.recFileClaim,
          estimatedScope: d.recEstimatedScope || '',
          nextSteps: d.recNextSteps || ''
        };
        d.notes = d.stormNotes || '';
      }

      // 4) Supplement: line items from class-based inputs
      if (state.templateId === 'supplement') {
        const items = [];
        container.querySelectorAll('#supplemental-items-container .line-item').forEach(row => {
          items.push({
            description: row.querySelector('.item-description')?.value || '',
            xactCode: row.querySelector('.item-code')?.value || '',
            quantity: row.querySelector('.item-qty')?.value || '',
            unitCost: row.querySelector('.item-cost')?.value || '',
            reason: row.querySelector('.item-reason')?.value || ''
          });
        });
        d.supplementalItems = items;
      }

      // 5) Completion: nested materials/warranty + work-completed checklist
      if (state.templateId === 'completion') {
        d.materials = {
          manufacturer: d.manufacturer || '',
          productLine: d.productLine || '',
          color: d.color || ''
        };
        d.warrantyInfo = {
          materialWarranty: d.materialWarranty || '',
          laborWarranty: d.laborWarranty || '',
          registrationNumber: d.registrationNumber || ''
        };
        const work = {};
        container.querySelectorAll('#work-completed-checklist .comp-row').forEach(row => {
          const name = row.dataset.work;
          const status = row.querySelector('.work-status')?.value || '';
          if (status) work[name] = status;
        });
        d.workCompleted = work;
      }
    },

    /**
     * Handle next step
     */
    async _handleNextStep(container, state, lead) {
      // Native form-constraint validation (required fields, etc.)
      let valid = true;
      container.querySelectorAll('form').forEach(form => {
        if (!form.checkValidity()) {
          form.reportValidity?.();
          valid = false;
        }
      });
      if (!valid) {
        showToast('Please fill in required fields', 'warning');
        return;
      }

      // Step 0 requires a template choice
      if (state.currentStep === 0 && !state.templateId) {
        showToast('Choose a report template to continue', 'warning');
        return;
      }

      // Collect (with nested assembly) before advancing
      this._collectCurrentStep(container, state);

      if (state.currentStep === 4) {
        await this._generateAndOpen(state, container);
      } else {
        state.currentStep++;
        container.innerHTML = this._renderBuilderUI(state);
        this._attachBuilderListeners(container, state, lead);
      }
    },

    /**
     * Handle previous step — preserves anything typed before going back.
     */
    _handlePrevStep(container, state, lead) {
      if (state.currentStep > 0) {
        this._collectCurrentStep(container, state);
        state.currentStep--;
        container.innerHTML = this._renderBuilderUI(state);
        this._attachBuilderListeners(container, state, lead);
      }
    },

    /**
     * Generate and open the report.
     *
     * D-2: tries the new server-side Puppeteer renderer first. The
     * legacy blob-popup path stays as a fallback so reps are never
     * blocked if the callable errors out. Only the full-inspection
     * template currently has a server template; storm-damage,
     * supplement, and completion still go through the legacy path
     * until D-2 follow-ups port them.
     */
    async _generateAndOpen(state, container) {
      this._saveDraft(state.leadId, state.data);

      const saveEl = container && container.querySelector('#save-to-db');
      const wantSave = !!(saveEl && saveEl.checked);

      // Always build the client HTML — used for the legacy popup AND for
      // persisting a self-contained copy when "Save to database" is on.
      const html = this.generateReport(state.leadId, state.templateId, state.data);

      // INSP-1: persist to Firestore when requested (was a dead checkbox).
      // Do it first so a saved copy survives even if the popup is blocked.
      if (wantSave) {
        if (html) {
          const lead = this._getLead(state.leadId) || {};
          await this.saveReport(state.leadId, state.templateId, {
            html,
            data: state.data,
            photoIds: (state.data.photos || []).map(p => p.url).filter(Boolean),
            propertyAddress: lead.address || state.data.address || '',
            inspectorName: state.data.inspectorName || '',
            inspectionDate: state.data.inspectionDate || ''
          });
        } else {
          showToast('Could not build report to save', 'error');
        }
      }

      // ── D-2 server path (full-inspection only) ──
      if (state.templateId === 'full-inspection') {
        try {
          const ok = await this._tryServerRender(state);
          if (ok) return;
        } catch (e) {
          console.warn('[inspection] server render failed, falling back:', e && e.message || e);
        }
      }

      // ── Legacy blob-popup path (always runs for non-full-inspection
      //    templates, or as fallback after a server-render error) ──
      if (!html) {
        showToast('Failed to generate report', 'error');
        return;
      }
      const blob = new Blob([html], { type: 'text/html' });
      const blobUrl = URL.createObjectURL(blob);
      window.open(blobUrl, '_blank');
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);

      showToast('Report generated! Use Print or Save as PDF from the browser.', 'success');
    },

    /**
     * D-2: Try the server-side renderer. Builds the inspection payload
     * from the wizard state, calls renderPdf, opens NBDDocViewer with
     * the returned signed URL. Returns true on success so the caller
     * can short-circuit the legacy path.
     */
    async _tryServerRender(state) {
      if (!window._functions || !window._httpsCallable) {
        const mod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js');
        window._functions = mod.getFunctions();
        window._httpsCallable = mod.httpsCallable;
      }
      const payload = this._buildInspectionPayload(state);
      if (!payload) return false;

      showToast('Rendering report…', 'info');

      const fn = window._httpsCallable(window._functions, 'renderPdf');
      const slug = (payload.leadName || 'inspection').replace(/[^A-Za-z0-9]+/g, '-').substring(0, 40);
      // Tenant-resolved prefix. Same class as the estimate/photo-report server
      // renders: functions/render-pdf.js takes this string verbatim, so it is
      // what lands on the homeowner's or adjuster's disk.
      const _inspBase = 'Inspection-' + slug + '-' + payload.reportNumber + '.pdf';
      const filename = window._tenantFileName ? await window._tenantFileName(_inspBase) : _inspBase;

      const r = await fn({
        template: 'inspection',
        payload,
        filename,
      });
      const data = r && r.data;
      if (!data || !data.ok || !data.url) throw new Error('Render returned no URL');

      if (window.NBDDocViewer && typeof window.NBDDocViewer.open === 'function') {
        window.NBDDocViewer.open({
          url:      data.url,
          title:    'Inspection Report' + (payload.leadName ? ' — ' + payload.leadName : ''),
          filename: data.filename || filename,
          leadId:   state.leadId,
        });
      } else {
        window.open(data.url, '_blank', 'noopener');
      }
      const ms = data.timing && data.timing.totalMs;
      showToast(ms ? `✓ Report rendered in ${ms}ms` : '✓ Report rendered', 'success');
      return true;
    },

    /**
     * Map the wizard's internal state to the new inspection.hbs
     * payload shape. Centralized here so the template stays the only
     * place that knows the doc structure.
     */
    _buildInspectionPayload(state) {
      const lead = this._getLead(state.leadId);
      if (!lead) return null;
      const d = state.data || {};

      const leadName = (lead.name && String(lead.name).trim())
        || ((lead.firstName || '') + ' ' + (lead.lastName || '')).trim()
        || 'Customer';
      const reportNumber = 'INS-' + Date.now().toString().slice(-6);

      // Components → findings rows (only those with a recorded condition).
      const findings = [];
      const components = d.components || {};
      Object.keys(components).forEach((compName) => {
        const c = components[compName] || {};
        if (!c.condition) return; // skip un-rated components
        findings.push({
          component: compName,
          condition: c.condition,
          notes: c.notes || '',
        });
      });

      // Stat cards — pulled from inspection meta + content counts.
      const stats = [
        { label: 'Total Squares', value: d.totalSquares || '—', sub: d.roofType || '' },
        { label: 'Components Inspected', value: String(findings.length), sub: 'rated Good → Critical' },
        { label: 'Scope Items', value: String((d.estimatedWork || []).length), sub: 'recommended for follow-up' },
      ];

      // Property overview KV pairs.
      const property = [];
      if (d.roofType)      property.push({ label: 'Roof Type',     value: d.roofType });
      if (d.roofAge)       property.push({ label: 'Approx. Age',    value: d.roofAge });
      if (d.totalSquares)  property.push({ label: 'Total Squares',  value: d.totalSquares });
      if (d.slopes)        property.push({ label: 'Slopes',         value: String(d.slopes) });

      // Photo evidence — pulled from PhotoEngine if available. We map
      // to the inspection.hbs photo shape: { url, caption, area, severity }.
      const photos = [];
      // Same fix as _loadPhotosForSelection above: this guard could never
      // pass, so every generated report's photo-evidence section (and the
      // D-2.7 before/after pairs below) shipped empty.
      const photoPool = (state.leadId && window._photoCache && window._photoCache[state.leadId]) || [];
      photoPool.slice(0, 24).forEach((p) => {
        // thumb/med/full — see urlOf above; `lg`/`md` never existed.
        const url = (p && p.urls && (p.urls.full || p.urls.med)) || (p && p.url) || '';
        if (!url) return;
        photos.push({
          url,
          // aiSuggestion.caption is the real Claude-Vision field; aiCaption never written.
          caption:  p.caption || (p.aiSuggestion && p.aiSuggestion.caption) || p.aiCaption || '',
          area:     p.location || p.area || p.phase || '',
          severity: p.severity || '',
        });
      });

      // D-2.7: build before/after pairs from the same photo pool.
      // Pairing rule: same `location`, one `Before` + one `After`,
      // most-recent of each wins. Empty array when nothing pairs.
      const photoPairs = (function () {
        const byLoc = new Map();
        photoPool.forEach((p) => {
          const loc = (p.location || '').trim();
          if (!loc) return;
          const phase = String(p.phase || '').toLowerCase();
          if (phase !== 'before' && phase !== 'after') return;
          if (!byLoc.has(loc)) byLoc.set(loc, { before: null, after: null });
          const slot = byLoc.get(loc);
          const ms = (p.createdAt && (p.createdAt.toMillis ? p.createdAt.toMillis() : (p.createdAt.seconds ? p.createdAt.seconds * 1000 : 0))) || 0;
          if (phase === 'before') {
            if (!slot.before || ms > slot.before._ms) slot.before = Object.assign({}, p, { _ms: ms });
          } else {
            if (!slot.after  || ms > slot.after._ms)  slot.after  = Object.assign({}, p, { _ms: ms });
          }
        });
        const out = [];
        byLoc.forEach((slot, loc) => {
          if (!slot.before || !slot.after) return;
          const bUrl = (slot.before.urls && (slot.before.urls.full || slot.before.urls.med)) || slot.before.url;
          const aUrl = (slot.after.urls  && (slot.after.urls.full  || slot.after.urls.med))  || slot.after.url;
          if (!bUrl || !aUrl) return;
          out.push({
            location: loc,
            before: { url: bUrl },
            after:  { url: aUrl },
          });
        });
        // 8 max — the PDF only needs the strongest comparisons.
        return out.slice(0, 8);
      })();

      // Scope rows from estimatedWork. totalScope is the sum of the
      // per-row costs the rep entered (legacy drafts used `total`);
      // null when nothing priced so the template hides the footer.
      const scopeItems = Array.isArray(d.estimatedWork) ? d.estimatedWork : [];
      const scope = scopeItems.map((w) => {
        const c = Number(w.cost != null ? w.cost : w.total);
        return {
          area:     w.area || w.location || '',
          item:     w.description || w.item || '',
          severity: w.severity || '',
          quantity: w.quantity || w.qty || '',
          cost:     isFinite(c) && c > 0 ? c : null,
          notes:    w.notes || '',
        };
      });
      const scopeTotal = scopeItems.reduce((sum, w) => {
        const n = Number(w.cost != null ? w.cost : w.total);
        return sum + (isFinite(n) ? n : 0);
      }, 0);

      const summary = {
        headline: 'Inspection findings & recommended scope',
        body: d.damageAssessment && d.damageAssessment.summary
          ? d.damageAssessment.summary
          : '',
      };

      // D-2.5: shared cover-page partial payload. Same shape every
      // doc sends, so the brand stays consistent and only template-
      // specific content (eyebrow / tagline) varies.
      // gauntlet Batch 3 — the cover page renders preparedBy VERBATIM (the
      // server {{company}} chrome does not override it), so resolve the tenant
      // brand and de-brand preparedBy or a stranger tenant's inspection cover
      // would still read "No Big Deal Home Solutions · (859) 420-7382". NBD keeps
      // the exact literals → byte-identical. Mirrors customer-photo-report-generator.js.
      const _b = (window._brand && window._brand()) || null;
      const isNbd = !_b || !_b.legalName || _b.legalName === 'No Big Deal Home Solutions';
      const _bc = (_b && _b.contact) || {};

      const inspectorName = d.inspectorName
        || (window._user && (window._user.displayName || window._user.email))
        || (isNbd ? 'NBD Inspector' : (_b.legalName ? (_b.legalName + ' Inspector') : 'Inspector'));

      const inspectionDateRaw = d.inspectionDate || new Date();
      const inspectionDateFmt = (function () {
        let dt;
        if (inspectionDateRaw instanceof Date) dt = inspectionDateRaw;
        else if (typeof inspectionDateRaw === 'string') dt = new Date(inspectionDateRaw);
        else dt = new Date();
        return isNaN(dt.getTime())
          ? String(inspectionDateRaw)
          : dt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
      })();

      const preparedFor = {
        name:        leadName,
        address:     lead.address || '',
        customerId:  lead.customerId || null,
        projectLine: d.roofType
          ? `${d.roofType}${d.totalSquares ? ' · ' + d.totalSquares + ' squares' : ''}`
          : null,
      };
      const preparedBy = {
        name:  inspectorName,
        role:  'Inspector · ' + (isNbd ? 'No Big Deal Home Solutions' : _b.legalName),
        phone: isNbd ? '(859) 420-7382' : (_bc.phone || ''),
        email: isNbd ? 'jd@nobigdealwithjoedeal.com' : (_bc.email || ''),
      };
      const projectMeta = [
        { label: 'Inspection Date', value: inspectionDateFmt },
        { label: 'Claim No.',       value: lead.claimNumber || '—' },
        { label: 'Report No.',      value: reportNumber },
      ];

      return {
        leadName,
        address: lead.address || '',
        inspectionDate: d.inspectionDate || new Date(),
        inspectorName,
        reportNumber,
        summary,
        stats,
        property,
        findings,
        photos,
        scope,
        totalScope: scopeTotal > 0 ? scopeTotal : null,
        recommendations: d.recommendations || '',
        // D-2.7: paired before/after photos by location
        photoPairs,
        // D-2.5 cover fields
        coverPhoto:    (photos[0] && photos[0].url) || null,
        coverCaption:  (photos[0] && photos[0].caption) || (photos[0] && photos[0].area) || null,
        coverTagline:  'Where your roof<br>stands today.',
        coverSub:      'A visual record of the property at the time of inspection — components, conditions, and the scope we recommend bringing the roof back to standard.',
        preparedFor,
        preparedBy,
        projectMeta,
      };
    },

    /**
     * Render list of reports
     */
    async renderReportList(containerId, leadId) {
      const container = document.getElementById(containerId);
      if (!container) return;

      container.innerHTML = '<p>Loading reports...</p>';

      const reports = await this.getReports(leadId);

      container.innerHTML = `
        <div style="padding: 20px;">
          <h2 style="color: ${BRAND.colors.navy}; margin-bottom: 20px;">
            Reports for this Lead (${reports.length})
          </h2>

          ${reports.length === 0 ? `
            <p style="color: #666;">No reports generated yet.</p>
          ` : `
            <div style="display: grid; gap: 15px;">
              ${reports.map(report => `
                <div style="border: 1px solid #ddd; border-radius: 4px; padding: 15px; display: flex; justify-content: space-between; align-items: center;">
                  <div>
                    <h3 style="margin: 0 0 5px 0; color: ${BRAND.colors.navy};">${this._escapeHtml(report.type)}</h3>
                    <p style="margin: 0; font-size: 12px; color: #666;">
                      ${new Date(report.createdAt?.toDate?.() || report.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <div style="display: flex; gap: 10px;">
                    <button class="btn-open-report" data-report-id="${report.id}" style="padding: 8px 16px; background: ${BRAND.colors.orange}; color: white; border: none; border-radius: 3px; cursor: pointer;">
                      View
                    </button>
                    <button class="btn-share-report" data-report-id="${report.id}" style="padding: 8px 16px; background: #1A3057; color: white; border: none; border-radius: 3px; cursor: pointer;">
                      Share
                    </button>
                    <button class="btn-delete-report" data-report-id="${report.id}" style="padding: 8px 16px; background: #ccc; color: #333; border: none; border-radius: 3px; cursor: pointer;">
                      Delete
                    </button>
                  </div>
                </div>
              `).join('')}
            </div>
          `}
        </div>
      `;

      // Attach listeners
      container.querySelectorAll('.btn-open-report').forEach(btn => {
        btn.addEventListener('click', (e) => this._openReport(e.currentTarget.dataset.reportId));
      });

      container.querySelectorAll('.btn-share-report').forEach(btn => {
        btn.addEventListener('click', (e) => this._shareReport(e.currentTarget.dataset.reportId));
      });

      container.querySelectorAll('.btn-delete-report').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          // Batch 2 (iOS PWA): use nbdConfirm so the destructive delete
          // gate works in standalone mode (native confirm always returns
          // true there).
          const _ask = window.nbdConfirm || ((m) => Promise.resolve(window.confirm(m)));
          if (await _ask('Delete this report?')) {
            await this.deleteReport(e.currentTarget.dataset.reportId);
            this.renderReportList(containerId, leadId);
          }
        });
      });
    },

    /**
     * Open a saved report
     */
    async _openReport(reportId) {
      try {
        if (!window._db) return;

        const { doc, getDoc } = await import(
          'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
        );

        const reportDoc = await getDoc(doc(window._db, REPORTS_COLLECTION, reportId));
        if (!reportDoc.exists()) {
          showToast('Report not found', 'error');
          return;
        }

        const report = reportDoc.data();
        // Render through the sandboxed NBDDocViewer (<iframe srcdoc> WITHOUT
        // allow-same-origin) rather than window.open(blob:), which is same-
        // origin and lets any script in a stored report read parent.window.auth
        // / steal an ID token. Defense-in-depth alongside the companyId-pin rule
        // fix: even a malicious report written before that rule can't execute
        // same-origin. Fall back to a blob tab only if the viewer isn't loaded.
        if (window.NBDDocViewer && typeof window.NBDDocViewer.open === 'function') {
          window.NBDDocViewer.open({
            html:     report.html,
            title:    report.title || ('Inspection Report' + (report.leadName ? ' — ' + report.leadName : '')),
            filename: (report.title || 'inspection-report') + '.html',
          });
        } else {
          const blob = new Blob([report.html], { type: 'text/html' });
          const blobUrl = URL.createObjectURL(blob);
          window.open(blobUrl, '_blank');
          setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
        }
      } catch (err) {
        console.error('Error opening report:', err);
        showToast('Failed to open report', 'error');
      }
    },

    /**
     * Save draft to localStorage
     */
    _saveDraft(leadId, data) {
      const key = STORAGE_KEY_DRAFT + leadId;
      localStorage.setItem(key, JSON.stringify(data));
    },

    /**
     * Load draft from localStorage
     */
    _loadDraft(leadId) {
      const key = STORAGE_KEY_DRAFT + leadId;
      const data = localStorage.getItem(key);
      return data ? JSON.parse(data) : null;
    },

    /**
     * Get lead from window._leads
     */
    _getLead(leadId) {
      if (!window._leads) return null;
      return window._leads.find(lead => lead.id === leadId);
    },

    /**
     * INSP-6: lead overlaid with any property-step edits the rep made in
     * the wizard, so corrected address/owner/phone/email reach the report
     * (templates read lead.* — this keeps that, but lets edits win).
     */
    _effectiveLead(leadId, data) {
      const base = this._getLead(leadId);
      if (!base) return null;
      const d = data || {};
      return Object.assign({}, base, {
        address: d.address || base.address,
        // Form-created leads carry firstName/lastName, not `name` — reading
        // base.name alone printed "N/A" as the homeowner on the report.
        name: d.ownerName || ((base.firstName || '') + ' ' + (base.lastName || '')).trim() || base.name,
        phone: d.phone || base.phone,
        email: d.email || base.email
      });
    },

    /**
     * Escape HTML
     */
    // Real brand artwork for the report cover, replacing the house emoji
    // that used to stand in for it. Returns '' when nothing resolves, so the
    // company name alone carries the header — a report with no logo is fine,
    // a report wearing another company's logo is not.
    _brandLogoImg() {
      try {
        const src = (typeof window !== 'undefined' && window._brandLogoSrc)
          ? window._brandLogoSrc() : '';
        if (!src) return '';
        return '<img src="' + this._escapeHtml(src) + '" alt="" ' +
               'style="display:block;width:150px;height:auto;flex-shrink:0;"/>';
      } catch (_) { return ''; }
    },

    _escapeHtml(text) {
      if (!text) return '';
      const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
      };
      return String(text).replace(/[&<>"']/g, m => map[m]);
    },

    /**
     * Wave 12: Render the AI damage analysis as a caption block
     * beneath each photo in the report. Only emits markup when the
     * photo has aiAnalysis stamped — silent fallback to nothing
     * otherwise. Also skips low-confidence "notRoof" results so
     * mis-tagged photos don't pollute the report.
     */
    _renderPhotoAIAnalysis(photo) {
      const a = photo && photo.aiAnalysis;
      if (!a || a.notRoof) return '';
      const sevColors = {
        none:     { bg: '#dcfce7', fg: '#166534', label: 'No damage' },
        minor:    { bg: '#fef9c3', fg: '#854d0e', label: 'Minor damage' },
        moderate: { bg: '#ffedd5', fg: '#9a3412', label: 'Moderate damage' },
        severe:   { bg: '#fee2e2', fg: '#991b1b', label: 'Severe damage' },
      };
      const sev = sevColors[a.severity] || sevColors.none;
      const obs = Array.isArray(a.observations)
        ? a.observations.slice(0, 3).map(o => `<li>${this._escapeHtml(o)}</li>`).join('')
        : '';
      return `
        <div class="ai-analysis-block" style="
          margin-top:6px; padding:8px 10px; border-radius:6px;
          background:${sev.bg}; color:${sev.fg};
          font-size:11px; line-height:1.4;">
          <div style="font-weight:700; margin-bottom:4px; text-transform:uppercase; letter-spacing:0.3px;">
            AI Assessment — ${this._escapeHtml(sev.label)}
          </div>
          ${obs ? `<ul style="margin:0; padding-left:16px;">${obs}</ul>` : ''}
        </div>`;
    }
  };

  // Export to window
  window.InspectionReportEngine = Engine;

  // Make showToast available if not already
  if (typeof window.showToast !== 'function') {
    window.showToast = (msg, type = 'info') => {
      console.log(`[${type.toUpperCase()}] ${msg}`);
    };
  }

})();
