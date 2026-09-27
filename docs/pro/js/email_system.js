// ═══════════════════════════════════════════════════════════════════════
// EMAIL INTEGRATION SYSTEM - Send estimates, reports, and follow-ups
// ═══════════════════════════════════════════════════════════════════════

// Email service configuration (using EmailJS or similar)
// For now, we'll use mailto: links with pre-populated content
// In production, integrate with SendGrid, Mailgun, or AWS SES

let _NBD_ES_DELEGATE, openEmailModal, closeEmailModal, emailEstimatePDF, emailFollowUp, _emailAttachment, _emailContext, _emailLeadId; // module-local (globals Tranche 1 — was window.*)
window.emailSystem = {
  // Template library
  templates: {
    estimateReady: {
      subject: '📋 Your Estimate from {companyName}',
      body: `Hi {customerName},

Thank you for choosing {companyName} for your {damageType} project.

Your estimate is ready for review. Please see the attached PDF for full details.

Project: {projectName}
Total: {total}

We're committed to providing the highest quality work at fair prices. If you have any questions or would like to discuss the estimate, please don't hesitate to reach out.

Best regards,
{repName}
{companyName}
{companyPhone}
{companyEmail}`
    },
    
    photoReportReady: {
      subject: '📸 Property Photo Report - {address}',
      body: `Hi {customerName},

Attached is the comprehensive photo report for your property at {address}.

This report includes:
- {photoCount} high-resolution photos
- Detailed documentation of damage/conditions
- Professional annotations and notes

Please review and let me know if you need any additional documentation.

Best regards,
{repName}
{companyName}
{companyPhone}
{companyEmail}`
    },
    
    followUp: {
      subject: 'Following up on your estimate',
      body: `Hi {customerName},

I wanted to follow up on the estimate I sent for your {damageType} project at {address}.

Do you have any questions about the scope of work or pricing? I'm happy to walk through the details or make any adjustments needed.

Our schedule is filling up, so please let me know if you'd like to move forward.

Best regards,
{repName}
{companyName}
{companyPhone}
{companyEmail}`
    },
    
    inspectionScheduled: {
      subject: '🔍 Inspection Scheduled - {address}',
      body: `Hi {customerName},

This confirms your inspection appointment:

Date: {inspectionDate}
Time: {inspectionTime}
Location: {address}

I'll conduct a thorough assessment and provide recommendations. The inspection typically takes 30-45 minutes.

See you then!

{repName}
{companyName}
{companyPhone}
{companyEmail}`
    }
  },
  
  // Resolve the logged-in rep's display name for the email signature.
  // Auto-injected by populateTemplate so callers don't have to pass it.
  _repName() {
    try {
      const a = window.auth && window.auth.currentUser;
      if (a && (a.displayName || a.email)) return a.displayName || a.email;
      const u = window._user;
      if (u && (u.displayName || u.email)) return u.displayName || u.email;
    } catch(e){}
    // No resolvable rep name → team fallback. NBD → 'The NBD Team' (byte-
    // identical); a non-NBD tenant → '<their legalName> Team', never 'NBD'.
    try {
      const b = (typeof window._brand === 'function') ? window._brand() : null;
      const isNbd = !b || !b.legalName || b.legalName === 'No Big Deal Home Solutions';
      if (!isNbd) return b.legalName + ' Team';
    } catch (e) {}
    return 'The NBD Team';
  },

  // Resolve the tenant's brand fields for the email templates. Mirrors
  // review-engine.js: window._brand() (TenantContext / company-profile.js)
  // drives companyName/phone/email/website so a tenant's homeowner emails
  // carry THEIR identity, never Joe's. NBD (no brand, or the canonical NBD
  // legalName) resolves to the current literals → byte-identical output.
  _brandFields() {
    let b = null;
    try { if (typeof window._brand === 'function') b = window._brand() || null; } catch (e) { b = null; }
    const isNbd = !b || !b.legalName || b.legalName === 'No Big Deal Home Solutions';
    const c = (b && b.contact) || {};
    const legalName = (b && b.legalName) || 'No Big Deal Home Solutions';
    return {
      companyName:      legalName,
      // Short-form NBD signature ('NBD Home Solutions') stays byte-identical for
      // NBD; a tenant gets their full legalName (no 'NBD' abbreviation leak).
      companyNameShort: isNbd ? 'NBD Home Solutions' : legalName,
      // Gate contact on isNbd — do NOT `|| NBD-literal`. _resolveBrand() blanks
      // an unset contact field to '' for a non-NBD tenant, so `c.phone || literal`
      // would re-inject NBD's phone/email/site (and misroute reply_to to Joe).
      // NBD keeps the exact literal; a tenant with no contact set renders blank.
      companyPhone:     isNbd ? '(859) 420-7382'              : (c.phone   || ''),
      companyEmail:     isNbd ? 'jd@nobigdealwithjoedeal.com' : (c.email   || ''),
      companyWebsite:   isNbd ? 'nobigdealwithjoedeal.com'    : (c.website || ''),
    };
  },

  // Populate template with customer data
  populateTemplate(templateKey, data) {
    const template = this.templates[templateKey];
    if (!template) return null;

    let subject = template.subject;
    let body = template.body;

    // Auto-inject the current rep's name unless the caller supplied one, plus
    // the resolved tenant brand fields (companyName/phone/email/website) so the
    // {company*} placeholders below substitute the tenant's identity. Caller
    // data still wins over both defaults.
    const merged = Object.assign({ repName: this._repName() }, this._brandFields(), data || {});

    // Replace placeholders
    Object.keys(merged).forEach(key => {
      const value = merged[key] || '';
      subject = subject.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
      body = body.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
    });

    return { subject, body };
  }
};

// ═══════════════════════════════════════════════════════════════════════
// EMAIL MODAL - Compose and send emails
// ═══════════════════════════════════════════════════════════════════════

openEmailModal = function(options = {}) {
  const {
    to = '',
    subject = '',
    body = '',
    attachmentName = '',
    attachmentData = null, // PDF blob or data
    leadId = null,
    context = 'general' // 'estimate', 'photoReport', 'followUp'
  } = options;
  
  // Store attachment data globally for access
  _emailAttachment = attachmentData;
  _emailLeadId = leadId;
  _emailContext = context;
  
  const modal = document.createElement('div');
  modal.id = 'emailModal';
  modal.className = 'modal';
  modal.style.cssText = 'display:flex;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:var(--z-overlay,10000);align-items:center;justify-content:center;';

  // Escape user/lead-sourced values before interpolating into innerHTML below.
  // to/subject/body originate from lead docs (which can come from PUBLIC intake),
  // so a name/address containing " < > & would break the markup or inject script.
  const esc = function(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); };
  
  modal.innerHTML = `
    <div class="modal-content" style="max-width:700px;width:95%;max-height:90vh;overflow:hidden;display:flex;flex-direction:column;background:var(--s);border-radius:12px;">
      <div class="modal-header" style="padding:25px;background:linear-gradient(135deg, #BD5728 0%, #A14A22 100%);color:white;">
        <h3 style="margin:0;font-size:22px;">📧 Send Email</h3>
        <button data-es-action="closeEmailModal" style="position:absolute;top:20px;right:20px;background:none;border:none;color:white;font-size:28px;cursor:pointer;line-height:1;">&times;</button>
      </div>
      
      <div style="flex:1;overflow-y:auto;padding:25px;">
        <div style="margin-bottom:15px;">
          <label style="display:block;font-weight:600;margin-bottom:6px;">To:</label>
          <input type="email" id="emailTo" value="${esc(to)}" placeholder="customer@example.com"
                 style="width:100%;padding:10px;border:1px solid var(--br);border-radius:6px;font-size:14px;">
        </div>
        
        <div style="margin-bottom:15px;">
          <label style="display:block;font-weight:600;margin-bottom:6px;">Subject:</label>
          <input type="text" id="emailSubject" value="${esc(subject)}"
                 style="width:100%;padding:10px;border:1px solid var(--br);border-radius:6px;font-size:14px;">
        </div>
        
        <div style="margin-bottom:15px;">
          <label style="display:block;font-weight:600;margin-bottom:6px;">Message:</label>
          <textarea id="emailBody" rows="12"
                    style="width:100%;padding:10px;border:1px solid var(--br);border-radius:6px;font-size:14px;resize:vertical;">${esc(body)}</textarea>
        </div>
        
        ${attachmentName ? `
          <div style="background:#f0f9ff;border:2px solid #0ea5e9;border-radius:8px;padding:15px;margin-bottom:15px;">
            <div style="display:flex;align-items:center;gap:10px;">
              <div style="font-size:32px;">📎</div>
              <div style="flex:1;">
                <div style="font-weight:600;color:var(--t);">${esc(attachmentName)}</div>
                <div style="font-size:12px;color:var(--m);">Attachment will be included</div>
              </div>
            </div>
          </div>
        ` : ''}
        
        <div style="background:#fff3cd;border-left:4px solid #ffc107;padding:12px;border-radius:4px;font-size:13px;">
          <strong>Note:</strong> This will open your default email client with the message pre-filled. Click "Send Email" to continue.
        </div>
      </div>
      
      <div class="modal-footer" style="padding:20px;border-top:2px solid var(--br);background:var(--s2);display:flex;gap:10px;justify-content:flex-end;">
        <button data-es-action="closeEmailModal" class="btn" style="background:#6c757d;border-color:#6c757d;color:#fff;">
          Cancel
        </button>
        <button data-es-action="sendEmail" class="btn btn-orange" style="display:flex;align-items:center;gap:8px;">
          <span>📧 Send Email</span>
        </button>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
  document.getElementById('emailTo').focus();
};

closeEmailModal = function() {
  const modal = document.getElementById('emailModal');
  if (modal) modal.remove();
  _emailAttachment = null;
  _emailLeadId = null;
};

window.sendEmail = async function() {
  const to = document.getElementById('emailTo').value.trim();
  const subject = document.getElementById('emailSubject').value.trim();
  const body = document.getElementById('emailBody').value.trim();

  if (!to || !subject || !body) {
    if(typeof showToast==='function') showToast('Please fill in all fields','error'); else alert('Please fill in all fields');
    return;
  }

  // Validate email
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(to)) {
    if(typeof showToast==='function') showToast('Please enter a valid email address','error'); else alert('Please enter a valid email address');
    return;
  }

  try {
    // If NBDComms is available, use Cloud Function to send
    if (window.NBDComms && typeof window.NBDComms.sendEmail === 'function') {
      const result = await window.NBDComms.sendEmail(to, subject, body, {
        leadId: _emailLeadId,
        html: null,
        // What this email IS — the server's unsubscribe gate reads it
        // (functions/email-suppression.js). null = commercial.
        kind: window.emailSystem.kindForContext(_emailContext)
      });

      if (result.success) {
        closeEmailModal();
        return;
      }
      // A platform REFUSAL (unsubscribed, role, register unreadable) is final:
      // NBDComms already told the rep why. Opening mailto: here would send the
      // same email from the rep's own mail app to someone who opted out.
      if (result && result.mode === 'platform') return;
      // Any other failure: fall through to the mailto fallback
    }

    // Fallback: Log and use mailto
    if (_emailLeadId && window.db) {
      const _eu = window.auth?.currentUser;
      await window.addDoc(window.collection(window.db, 'emails'), {
        leadId: _emailLeadId,
        to: to,
        subject: subject,
        body: body,
        context: _emailContext || 'general',
        hasAttachment: !!_emailAttachment,
        sentAt: window.serverTimestamp(),
        sentBy: _eu?.email || 'Unknown',
        // Bind ownership to the immutable uid (rules prefer this over the
        // mutable token email). Only set when present so unauth fallbacks
        // don't write an empty value that would fail the create rule.
        ...(_eu?.uid ? { sentByUid: _eu.uid } : {})
      });
    }

    // If attachment exists, download it
    if (_emailAttachment) {
      alert('⚠️ Email will open with message pre-filled.\n\nThe PDF has been downloaded to your computer.\nPlease attach it manually before sending.');
      const link = document.createElement('a');
      link.href = URL.createObjectURL(_emailAttachment);
      link.download = `attachment_${Date.now()}.pdf`;
      link.click();
      URL.revokeObjectURL(link.href);
    }

    // Open mailto link
    const mailtoLink = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    window.location.href = mailtoLink;

    // Close modal after short delay
    setTimeout(() => {
      closeEmailModal();

      // Show success message
      if (typeof showToast === 'function') {
        showToast('✅ Email client opened', 'success');
      }
    }, 500);

  } catch (error) {
    console.error('Email error:', error);
    if(typeof showToast==='function') showToast('Failed to send email. Please try again.','error'); else alert('Failed to send email. Please try again.');
  }
};

// ═══════════════════════════════════════════════════════════════════════
// QUICK EMAIL FUNCTIONS - Trigger from various contexts
// ═══════════════════════════════════════════════════════════════════════

// Email estimate PDF
emailEstimatePDF = async function(estimateData, pdfBlob) {
  const lead = estimateData.customerId ? await getLeadData(estimateData.customerId) : null;
  
  const customerName = lead ? `${lead.firstName || ''} ${lead.lastName || ''}`.trim() : 'Customer';
  const email = lead?.email || '';
  
  const emailData = window.emailSystem.populateTemplate('estimateReady', {
    customerName: customerName,
    damageType: lead?.damageType || 'restoration',
    projectName: estimateData.projectName || 'Project',
    total: `$${(estimateData.total || 0).toLocaleString()}`
  });
  
  openEmailModal({
    to: email,
    subject: emailData.subject,
    body: emailData.body,
    attachmentName: `Estimate_${estimateData.projectName}.pdf`,
    attachmentData: pdfBlob,
    leadId: estimateData.customerId,
    context: 'estimate'
  });
};

// Email photo report
window.emailPhotoReport = async function(pdfBlob, leadId) {
  const lead = await getLeadData(leadId);
  
  const customerName = lead ? `${lead.firstName || ''} ${lead.lastName || ''}`.trim() : 'Customer';
  const email = lead?.email || '';
  const address = lead?.address || 'your property';
  const photoCount = window._customerPhotos?.length || 0;
  
  const emailData = window.emailSystem.populateTemplate('photoReportReady', {
    customerName: customerName,
    address: address,
    photoCount: photoCount
  });
  
  openEmailModal({
    to: email,
    subject: emailData.subject,
    body: emailData.body,
    attachmentName: `Photo_Report_${customerName}.pdf`,
    attachmentData: pdfBlob,
    leadId: leadId,
    context: 'photoReport'
  });
};

// Quick follow-up email
emailFollowUp = async function(leadId) {
  const lead = await getLeadData(leadId);
  
  const customerName = lead ? `${lead.firstName || ''} ${lead.lastName || ''}`.trim() : 'Customer';
  const email = lead?.email || '';
  
  const emailData = window.emailSystem.populateTemplate('followUp', {
    customerName: customerName,
    damageType: lead?.damageType || 'project',
    address: lead?.address || 'your property'
  });
  
  openEmailModal({
    to: email,
    subject: emailData.subject,
    body: emailData.body,
    leadId: leadId,
    context: 'followUp'
  });
};

// Email-modal context → the server's email kind (functions/email-suppression.js
// TRANSACTIONAL_KINDS). An estimate or photo report the customer is receiving
// is transactional; a stage template is whatever NBDComms says that stage is;
// 'followUp' / 'general' / anything else is commercial (null) and honours the
// tenant's unsubscribe register.
window.emailSystem.kindForContext = function (context) {
  const c = String(context || '');
  if (c === 'estimate') return 'estimate';
  if (c === 'photoReport') return 'document';
  if (c.indexOf('stage_') === 0 && window.NBDComms && typeof window.NBDComms.emailKindForStage === 'function') {
    return window.NBDComms.emailKindForStage(c.slice(6));
  }
  return null;
};

// Helper: Get lead data from Firestore
async function getLeadData(leadId) {
  if (!leadId || !window.db) return null;

  try {
    const leadSnap = await window.getDoc(window.doc(window.db, 'leads', leadId));
    return leadSnap.exists() ? leadSnap.data() : null;
  } catch (error) {
    console.error('Error fetching lead:', error);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// STAGE-AWARE EMAIL — Auto-selects the right template for the lead's stage
// ═══════════════════════════════════════════════════════════════════════

window.emailSystem.stageTemplates = {
  // ── Insurance pipeline ─────────────────────────────
  contacted: {
    subject: '🏠 Thank You for Choosing {companyNameShort}',
    body: `Hi {customerName},

Thank you for speaking with me about the damage at {address}. I'm looking forward to helping you through this process.

Here's what happens next:
1. I'll schedule a free inspection of your property
2. We'll document the damage thoroughly
3. I'll walk you through your insurance options

I'll be in touch shortly to set up a convenient time.

Best regards,
{repName}
{companyName}
{companyPhone}`
  },

  inspected: {
    subject: '🔍 Inspection Complete — {address}',
    body: `Hi {customerName},

I've completed the inspection at {address}. Here's a summary of what I found:

{damageType} damage identified. Based on my assessment, I recommend filing a claim with your insurance company.

Next steps:
1. File the claim with {carrier} (I can assist with this)
2. Schedule the adjuster inspection
3. Review the scope and estimate

Please let me know if you'd like me to walk you through filing the claim, or if you've already started the process.

{repName}
{companyName}
{companyPhone}`
  },

  claim_filed: {
    subject: '📋 Claim Filed — Next Steps for {address}',
    body: `Hi {customerName},

Good news — the claim has been filed with {carrier}. Your claim number is: {claimNumber}

What happens next:
1. {carrier} will assign an adjuster
2. The adjuster will schedule an inspection (usually within 7-14 days)
3. I'll be present at the adjuster meeting to ensure nothing is missed

I'll keep you updated as things move forward. Don't hesitate to reach out with questions.

{repName}
{companyName}
{companyPhone}`
  },

  adjuster_meeting_scheduled: {
    subject: '📅 Adjuster Meeting Confirmed — {address}',
    body: `Hi {customerName},

The adjuster meeting has been scheduled for your property at {address}.

What to expect:
- The adjuster will inspect the damage (30-60 minutes)
- I'll be there to walk through the damage with the adjuster
- They'll document findings and take measurements

Please make sure someone is home to provide access if needed. I'll arrive a few minutes early.

If you need to reschedule, let me know ASAP so we can coordinate with the insurance company.

{repName}
{companyName}
{companyPhone}`
  },

  scope_received: {
    subject: '📄 Scope Received — Reviewing Your Claim',
    body: `Hi {customerName},

We've received the scope of work from {carrier} for your property at {address}.

I'm reviewing the scope now to make sure everything is included. If the adjuster's scope misses anything, I'll prepare an updated estimate of my own showing the additional items.

I'll be in touch soon with the details and next steps.

{repName}
{companyName}
{companyPhone}`
  },

  estimate_submitted: {
    subject: '💰 Estimate Submitted — {address}',
    body: `Hi {customerName},

I've submitted the estimate for your project at {address}. Here are the details:

Estimated Total: {estimateAmount}

The insurance company will review this against their scope. I'm watching for approval and will keep you posted.

If your insurer's scope misses anything, I'll put together the supporting photos and documentation for you, and I can meet with your adjuster.

{repName}
{companyName}
{companyPhone}`
  },

  supplement_requested: {
    subject: '📝 Updated Estimate Sent — Additional Items',
    body: `Hi {customerName},

After reviewing the insurance scope for {address}, I found additional items that were missed. I've sent {carrier} my updated estimate for the work, with photos of those items.

This is normal — an updated estimate makes sure all the damage is documented and the job is done right. You manage your claim; I'll keep you posted on anything I hear back about my estimate.

{repName}
{companyName}
{companyPhone}`
  },

  contract_signed: {
    subject: '✍️ Contract Signed — Your Project is Scheduled!',
    body: `Hi {customerName},

Congratulations! Your project at {address} is officially moving forward.

Here's what happens next:
1. Permits (if required for your jurisdiction)
2. Materials ordered from our suppliers
3. Crew scheduling — I'll confirm the installation date with you

Estimated timeline: {scheduledDate}

Thank you for trusting {companyName}. We're going to do a great job for you.

{repName}
{companyName}
{companyPhone}`
  },

  crew_scheduled: {
    subject: '👷 Crew Scheduled — Installation Date Confirmed',
    body: `Hi {customerName},

Your installation at {address} is scheduled!

Scheduled Date: {scheduledDate}
Crew: {crew}

What to expect on installation day:
- Crew arrives early morning (typically 7-8 AM)
- Work usually takes 1-2 days depending on scope
- We'll keep the area clean and professional throughout

Please make sure vehicles are moved from the driveway. If you have any concerns, let me know before installation day.

{repName}
{companyName}
{companyPhone}`
  },

  install_complete: {
    subject: '🎉 Installation Complete — {address}',
    body: `Hi {customerName},

Great news — your installation at {address} is complete!

Next steps:
1. Final photos have been taken for documentation
2. Your warranty information is being prepared
3. Final payment details will be sent shortly

I'll swing by for a final walkthrough to make sure everything looks perfect. Please let me know if you notice anything.

{repName}
{companyName}
{companyPhone}`
  },

  closed: {
    subject: '🏆 Project Complete — Thank You!',
    body: `Hi {customerName},

Your project at {address} is officially complete! Thank you for trusting {companyName}.

Your warranty certificate is attached for your records. Please keep this in a safe place.

If you know anyone who needs roofing or home exterior work, we'd appreciate the referral. We offer a $100 referral bonus for every job that closes.

It was a pleasure working with you. Don't hesitate to reach out if you need anything in the future.

Best,
{repName}
{companyName}
{companyPhone}`
  },

  // ── Cash pipeline ──────────────────────────────────
  estimate_sent_cash: {
    subject: '💰 Your Estimate from {companyNameShort}',
    body: `Hi {customerName},

Thank you for requesting an estimate for your project at {address}.

Your estimate total: {estimateAmount}

This includes all materials, labor, and our lifetime workmanship warranty. We offer Standard, Preferred, and Elite options to fit your budget.

I'd love to walk you through the options. When's a good time to chat?

{repName}
{companyName}
{companyPhone}`
  },

  // ── Finance pipeline ───────────────────────────────
  prequal_sent: {
    subject: '🏦 Financing Pre-Qualification — {address}',
    body: `Hi {customerName},

I've sent you a financing pre-qualification link through our partner. This is a soft pull only — it won't affect your credit score.

Click here to check your options: {preQualLink}

Multiple lenders compete for your approval through the Acorn Finance marketplace, so you'll see the rates and terms you qualify for. Rates and terms vary by credit.

Let me know if you have any questions about the financing options.

{repName}
{companyName}
{companyPhone}`
  }
};

/**
 * Build stage-aware subject/body without opening the modal.
 * Used by EmailDrip "Send now" (platform path) and emailByStage.
 */
window.emailSystem.buildStageEmail = async function(leadId) {
  const lead = await getLeadData(leadId);
  if (!lead) return null;

  const stage = lead._stageKey || lead.stage || 'new';
  const customerName = `${lead.firstName || ''} ${lead.lastName || ''}`.trim() || 'Customer';
  const email = lead.email || '';
  if (!email) return { to: '', subject: '', body: '', stage, leadId };

  let template = window.emailSystem.stageTemplates[stage];
  if (!template) {
    // Generic follow-up body when no stage-specific template exists.
    template = {
      subject: 'Following up — {companyNameShort}',
      body: `Hi {customerName},\n\nWanted to check in on your project at {address}. Any questions I can help with?\n\n{repName}\n{companyName}\n{companyPhone}`,
    };
  }

  const data = {
    customerName,
    address: lead.address || 'your property',
    damageType: lead.damageType || 'storm/hail',
    carrier: lead.insCarrier || lead.insuranceCarrier || 'your insurance company',
    claimNumber: lead.claimNumber || '[pending]',
    estimateAmount: lead.estimateAmount ? '$' + parseFloat(lead.estimateAmount).toLocaleString() : '[pending]',
    scheduledDate: lead.scheduledDate || '[to be confirmed]',
    crew: lead.crew || 'our installation team',
    preQualLink: lead.preQualLink || '[link will be sent separately]',
    repName: window.emailSystem._repName(),
  };
  Object.assign(data, window.emailSystem._brandFields());

  let subject = template.subject;
  let body = template.body;
  Object.keys(data).forEach(key => {
    subject = subject.replace(new RegExp(`\\{${key}\\}`, 'g'), data[key]);
    body = body.replace(new RegExp(`\\{${key}\\}`, 'g'), data[key]);
  });

  return { to: email, subject, body, stage, leadId, customerName };
};

/**
 * Smart email — auto-selects template based on lead's current stage
 */
window.emailByStage = async function(leadId) {
  const built = await window.emailSystem.buildStageEmail(leadId);
  if (!built) { if(typeof showToast==='function') showToast('Lead not found','error'); else alert('Lead not found'); return; }
  if (!built.to) { if(typeof showToast==='function') showToast('No email on this lead','error'); return; }

  openEmailModal({
    to: built.to,
    subject: built.subject,
    body: built.body,
    leadId,
    context: `stage_${built.stage}`
  });
};

// ═══════════════════════════════════════════════════════════════════════
// EMAILJS INTEGRATION (optional — for real server-side sending)
// Configure in Firebase: users/{uid}/settings/emailjs
// ═══════════════════════════════════════════════════════════════════════

window.emailSystem.config = {
  provider: 'mailto', // 'mailto' | 'emailjs'
  emailjsServiceId: null,
  emailjsTemplateId: null,
  emailjsPublicKey: null,
};

/**
 * Load EmailJS config from Firestore (if configured)
 */
window.emailSystem.loadConfig = async function() {
  try {
    if (!window.db || !window._user) return;
    const configSnap = await window.getDoc(window.doc(window.db, 'users', window._user.uid, 'settings', 'emailjs'));
    if (configSnap.exists()) {
      const data = configSnap.data();
      if (data.serviceId && data.templateId && data.publicKey) {
        this.config.provider = 'emailjs';
        this.config.emailjsServiceId = data.serviceId;
        this.config.emailjsTemplateId = data.templateId;
        this.config.emailjsPublicKey = data.publicKey;
        console.log('✓ EmailJS configured — real email sending enabled');
      }
    }
  } catch (e) {
    console.warn('EmailJS config not found, using mailto fallback');
  }
};

/**
 * Send via EmailJS (when configured) or fall back to mailto
 */
window.emailSystem.send = async function(to, subject, body, options = {}) {
  if (this.config.provider === 'emailjs' && this.config.emailjsPublicKey) {
    try {
      // Load EmailJS SDK if not already loaded
      if (!window.emailjs) {
        const script = document.createElement('script');
        script.src = '/assets/vendor/emailjs/email.min.js';
        document.head.appendChild(script);
        await new Promise(resolve => script.onload = resolve);
        window.emailjs.init(this.config.emailjsPublicKey);
      }

      const _bf = window.emailSystem._brandFields();
      await window.emailjs.send(this.config.emailjsServiceId, this.config.emailjsTemplateId, {
        to_email: to,
        subject: subject,
        message: body,
        from_name: `${window.emailSystem._repName()} — ${_bf.companyNameShort}`,
        reply_to: _bf.companyEmail,
      });

      return { success: true, method: 'emailjs' };
    } catch (e) {
      console.error('EmailJS send failed, falling back to mailto:', e);
    }
  }

  // Fallback: mailto
  const mailtoLink = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  window.location.href = mailtoLink;
  return { success: true, method: 'mailto' };
};

console.log('✓ Email system loaded (with stage templates + EmailJS support)');


// CSP-safe delegation (replaces 3 inline onclicks killed by script-src-attr 'none')
(function(){if(_NBD_ES_DELEGATE)return;_NBD_ES_DELEGATE=true;document.addEventListener('click',function(ev){var t=ev.target.closest&&ev.target.closest('[data-es-action]');if(!t)return;var a=t.dataset.esAction;try{if(a==='closeEmailModal'&&typeof closeEmailModal==='function')closeEmailModal();else if(a==='sendEmail'&&typeof sendEmail==='function')sendEmail();}catch(e){console.error('[email_system]',e);}});})();
