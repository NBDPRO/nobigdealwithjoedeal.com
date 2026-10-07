(function () {
// ═══════════════════════════════════════════════════════════════════════
// CUSTOMER PAGE ENHANCEMENTS - Task Management & Improved UX
// ═══════════════════════════════════════════════════════════════════════

// ── Globals Tranche 3 T3-C (2026-09-18): cross-file callables, registry-only ──
// Each of these has exactly one consumer in another file (none is markup-
// dispatched, so _nbdCustomerActionDispatch's window walk never needs them).
// customer.html has no dashboard-bootstrap.module.js; customer-bootstrap.
// module.js creates this same registry with the same || guard, and whichever
// file runs first wins. Registered at the TOP of the wrap (all six are hoisted
// declarations) so a throw later in this 2500-line body can't strand them.
window.__NBD_CALL_REGISTRY = window.__NBD_CALL_REGISTRY || Object.create(null);
Object.assign(window.__NBD_CALL_REGISTRY, {
  renderCoverHero: renderCoverHero,             // customer-bootstrap.module.js
  loadPhotosByPhase: loadPhotosByPhase,         // customer-bootstrap.module.js
  loadNewPortalSections: loadNewPortalSections, // customer-bootstrap.module.js
  setupContactTab: setupContactTab,             // customer-bootstrap.module.js
  loadCommunicationLog: loadCommunicationLog,   // customer-ai-drafts-panel.js
  logGeneratedDoc: logGeneratedDoc,             // doc-preflight.js
});

// ── RoofLink-parity count badges ────────────────────────────────────
// Every module's loader already fetches its list — these two helpers
// just print the numbers. Window-exposed because callers live across
// customer-bootstrap.module.js and customer-photo-report-generator.js
// (script order isn't guaranteed, so every call site guards on typeof).
//
//   nbdNavCount('navCountPhotos', 16)  → "16" chip on the jump-nav link
//   nbdTitleCount('notesPanelTitle', 'Notes', 4) → "Notes (4)"
//
// n <= 0 hides the chip / restores the bare title.
window.nbdNavCount = function (badgeId, n) {
  var el = document.getElementById(badgeId);
  if (!el) return;
  n = Number(n) || 0;
  if (n > 0) {
    el.textContent = n > 99 ? '99+' : String(n);
    el.style.display = 'inline-block';
  } else {
    el.textContent = '';
    el.style.display = 'none';
  }
};
window.nbdTitleCount = function (titleId, base, n) {
  var el = document.getElementById(titleId);
  if (!el) return;
  n = Number(n) || 0;
  el.textContent = n > 0 ? base + ' (' + n + ')' : base;
};

// ── Cover photo (RoofLink "Set Cover") ──────────────────────────────
// The cover is persisted FLAT on the lead (coverPhotoId + a denormalized
// coverPhotoUrl) so every consumer — customer hero, mobile job-detail
// hero, kanban thumbs, estimate PDF cover — reads it without a photo
// lookup. Chosen from the photo quick-edit popup.
function renderCoverHero(url) {
  var hero = document.getElementById('coverHero');
  if (!hero) return;
  if (url && /^https?:/i.test(String(url))) {
    hero.style.backgroundImage = 'url("' + String(url).replace(/"/g, '%22') + '")';
    hero.style.display = 'block';
  } else {
    hero.style.backgroundImage = '';
    hero.style.display = 'none';
  }
}

window.setCoverPhotoFromPopup = async function (idx) {
  var photo = (window._allPhotos || [])[Number(idx)];
  if (!photo || !photo.url) return;
  var lead = window._currentLead || {};
  var isCover = lead.coverPhotoId === photo.id;
  // Tapping the current cover clears it (toggle) — no separate remove UI.
  var updates = isCover
    ? { coverPhotoId: null, coverPhotoUrl: null, updatedAt: new Date() }
    : { coverPhotoId: photo.id, coverPhotoUrl: photo.url, updatedAt: new Date() };
  try {
    await window.updateDoc(window.doc(window.db, 'leads', window._customerId), updates);
    Object.assign(lead, updates);
    renderCoverHero(updates.coverPhotoUrl);
    if (typeof window.showToast === 'function') {
      window.showToast(isCover ? 'Cover photo cleared' : 'Cover photo set ★', 'success');
    }
    if (typeof window._closePhotoActionPopup === 'function') window._closePhotoActionPopup();
  } catch (e) {
    console.error('Set cover failed:', e);
    if (typeof window.showToast === 'function') window.showToast('Could not set cover: ' + e.message, 'error');
  }
};

// Task Modal HTML (to be injected)
const taskModalHTML = `
<div id="taskModal" class="modal-bg">
  <div class="modal-content ct-w500">
    <div class="modal-header">
      <h3 style="margin:0;">Add Task</h3>
      <button data-action="closeTaskModal" class="ct-close-lg">&times;</button>
    </div>
    <div class="modal-body">
      <div class="ct-mb15">
        <label class="ct-label">Task Title *</label>
        <input type="text" id="taskTitle" placeholder="e.g., Schedule roof inspection" aria-label="Task title"
               class="ct-field">
      </div>
      
      <div class="ct-mb15">
        <label class="ct-label">Due Date</label>
        <input type="date" id="taskDueDate" 
               class="ct-field">
      </div>
      
      <div class="ct-mb15">
        <label class="ct-label">Priority</label>
        <select id="taskPriority" class="ct-field">
          <option value="low">Low</option>
          <option value="medium" selected>Medium</option>
          <option value="high">High</option>
        </select>
      </div>
      
      <div class="ct-mb15">
        <label class="ct-label">Notes (Optional)</label>
        <textarea id="taskNotes" rows="3" placeholder="Additional details..." 
                  class="ct-field ct-field-ta"></textarea>
      </div>
    </div>
    <div class="modal-footer">
      <button data-action="closeTaskModal" class="btn">
        Cancel
      </button>
      <button data-action="saveTask" class="btn btn-orange">
        Add Task
      </button>
    </div>
  </div>
</div>
`;

// Event modal (RoofLink "Add Event") — a named, dated timeline entry
// ("Adjuster meeting", "Contract signature"…). Stored in the SAME
// unified leads/{leadId}/tasks subcollection as type:'event' docs so it
// needs no new rules and rides team visibility; the timeline renders it
// as a 📅 milestone and the open-task badge ignores it.
const eventModalHTML = `
<div id="eventModal" class="modal-bg">
  <div class="modal-content ct-w500">
    <div class="modal-header">
      <h3 style="margin:0;">Add Event</h3>
      <button data-action="closeEventModal" class="ct-close-lg">&times;</button>
    </div>
    <div class="modal-body">
      <div class="ct-mb15">
        <label class="ct-label">Event Title *</label>
        <input type="text" id="eventTitle" placeholder="e.g., Adjuster meeting — contract signature" aria-label="Event title"
               class="ct-field">
      </div>
      <div class="ct-mb15">
        <label class="ct-label">Date & Time *</label>
        <input type="datetime-local" id="eventWhen" aria-label="Event date and time"
               class="ct-field">
      </div>
      <div class="ct-mb15">
        <label class="ct-label">Notes</label>
        <textarea id="eventNotes" rows="3" placeholder="Optional details…" aria-label="Event notes"
                  class="ct-field ct-field-ta"></textarea>
      </div>
    </div>
    <div class="modal-footer">
      <button data-action="closeEventModal" class="btn">
        Cancel
      </button>
      <button data-action="saveEvent" class="btn btn-orange">
        Add Event
      </button>
    </div>
  </div>
</div>
`;

// Inject task modal on page load
window.addEventListener('DOMContentLoaded', () => {
  if (!document.getElementById('taskModal')) {
    document.body.insertAdjacentHTML('beforeend', taskModalHTML);
  }
  if (!document.getElementById('eventModal')) {
    document.body.insertAdjacentHTML('beforeend', eventModalHTML);
  }
});

// Task Management Functions
window.openTaskModal = function() {
  // 2026-09-25: a viewer is read-only (Jo's decision B; role-gate.js).
  if (window.NBDRole && !window.NBDRole.guard()) return;
  document.getElementById('taskTitle').value = '';
  document.getElementById('taskDueDate').value = '';
  document.getElementById('taskPriority').value = 'medium';
  document.getElementById('taskNotes').value = '';
  window.nbdModal.open('taskModal');
  document.getElementById('taskTitle').focus();
};

window.closeTaskModal = function() {
  window.nbdModal.close('taskModal');
};

window.openEventModal = function() {
  document.getElementById('eventTitle').value = '';
  document.getElementById('eventWhen').value = '';
  document.getElementById('eventNotes').value = '';
  window.nbdModal.open('eventModal');
  document.getElementById('eventTitle').focus();
};

window.closeEventModal = function() {
  window.nbdModal.close('eventModal');
};

// Native alert() blocks the renderer until dismissed. standalone-compat.js
// only patches window.alert in PWA standalone mode (`if (!isStandalone)
// return`), so on desktop these stayed blocking. This module already reports
// through showToast everywhere else; the validation messages now match.
function _taskNotify(msg, kind) {
  if (typeof window.showToast === 'function') { window.showToast(msg, kind || 'info'); return; }
  if (kind === 'error') console.error('[tasks]', msg); else console.log('[tasks]', msg);
}

window.saveEvent = async function() {
  // 2026-09-25: a viewer is read-only (Jo's decision B; role-gate.js).
  if (window.NBDRole && !window.NBDRole.guard()) return;
  const title = document.getElementById('eventTitle').value.trim();
  const when = document.getElementById('eventWhen').value;
  const notes = document.getElementById('eventNotes').value.trim();
  if (!title) { _taskNotify('Enter an event title', 'warning'); return; }
  if (!when) { _taskNotify('Pick a date and time', 'warning'); return; }
  if (!window._customerId) { _taskNotify('Customer ID not found', 'error'); return; }
  try {
    // The one event writer (lead-events.js, 2026-10-03) — D2D's "Appointment
    // Set" books through it too. Inline copy kept only for a stale cache.
    if (window.NBDLeadEvents && typeof window.NBDLeadEvents.add === 'function') {
      await window.NBDLeadEvents.add(window._customerId, { title: title, when: when, notes: notes, source: 'manual' });
    } else await window.addDoc(window.collection(window.db, 'leads', window._customerId, 'tasks'), {
      type: 'event',
      leadId: window._customerId,
      userId: window.auth.currentUser?.uid || null,
      title: title,
      text: title,
      eventAt: new Date(when).toISOString(),
      notes: notes || '',
      done: false,
      source: 'manual',
      createdAt: window.serverTimestamp(),
      createdBy: window.auth.currentUser?.email || 'Unknown'
    });
    window.closeEventModal();
    const leadSnap = await window.getDoc(window.doc(window.db, 'leads', window._customerId));
    if (leadSnap.exists()) {
      await loadTimeline(window._customerId, leadSnap.data());
    }
    showToast('📅 Event added to the timeline', 'success');
  } catch (error) {
    console.error('Error saving event:', error);
    showToast('Could not save event — try again', 'error');
  }
};

window.saveTask = async function() {
  // 2026-09-25: a viewer is read-only (Jo's decision B; role-gate.js).
  if (window.NBDRole && !window.NBDRole.guard()) return;
  const title = document.getElementById('taskTitle').value.trim();
  const dueDate = document.getElementById('taskDueDate').value;
  const priority = document.getElementById('taskPriority').value;
  const notes = document.getElementById('taskNotes').value.trim();
  
  if (!title) {
    _taskNotify('Enter a task title', 'warning');
    return;
  }
  
  if (!window._customerId) {
    _taskNotify('Customer ID not found', 'error');
    return;
  }
  
  try {
    // Task unification: the CANONICAL store is the leads/{leadId}/tasks
    // subcollection — the same one the dashboard (tasks.js), notification
    // bell (_taskCache), and voice quick-capture already use. The old
    // top-level 'tasks' collection write made customer-page tasks
    // invisible everywhere else (and vice versa). `text` mirrors `title`
    // because the dashboard renders t.text.
    await window.addDoc(window.collection(window.db, 'leads', window._customerId, 'tasks'), {
      leadId: window._customerId,
      userId: window.auth.currentUser?.uid || null,
      title: title,
      text: title,
      dueDate: dueDate || null,
      priority: priority,
      notes: notes || '',
      done: false,
      createdAt: window.serverTimestamp(),
      createdBy: window.auth.currentUser?.email || 'Unknown'
    });

    closeTaskModal();

    // Reload timeline to show new task
    const leadSnap = await window.getDoc(window.doc(window.db, 'leads', window._customerId));
    if (leadSnap.exists()) {
      await loadTimeline(window._customerId, leadSnap.data());
    }
    
    // Show success feedback
    showToast('✓ Task added successfully', 'success');
    
  } catch (error) {
    console.error('Error saving task:', error);
    _taskNotify('Task not saved: ' + ((error && error.message) || 'unknown error'), 'error');
  }
};

// Toggle task completion
window.toggleTask = async function(taskId, newDoneState) {
  try {
    // Unified store: leads/{leadId}/tasks (see saveTask above).
    await window.updateDoc(window.doc(window.db, 'leads', window._customerId, 'tasks', taskId), {
      done: newDoneState,
      completedAt: newDoneState ? window.serverTimestamp() : null
    });
    
    // Reload timeline
    if (window._customerId) {
      const leadSnap = await window.getDoc(window.doc(window.db, 'leads', window._customerId));
      if (leadSnap.exists()) {
        await loadTimeline(window._customerId, leadSnap.data());
      }
    }
    
  } catch (error) {
    console.error('Error toggling task:', error);
    // The checkbox already flipped optimistically (native click). The write
    // failed, so tell the rep AND revert the UI to the real state by reloading
    // the timeline from Firestore — otherwise the box shows a "done" tick the
    // database never saved.
    if (typeof showToast === 'function') {
      showToast('Could not update task — check your connection and try again', 'error');
    }
    try {
      if (window._customerId) {
        const leadSnap = await window.getDoc(window.doc(window.db, 'leads', window._customerId));
        if (leadSnap.exists()) await loadTimeline(window._customerId, leadSnap.data());
      }
    } catch (_) { /* best-effort revert */ }
  }
};

// Toast notification system
// Toast — same visual + behavioral contract as the dashboard's ui.js system
// (2026-07-19 consolidation: this page had hardcoded Bootstrap colors on a
// themed app, no stacking — concurrent toasts overlapped at one point — no
// close button, and a flat 3s lifetime even for errors vs the dashboard's
// 9s). Themed surface, type left-borders, bottom-right stacking container,
// per-type durations, dismissible.
window.showToast = function(message, type = 'info') {
  // Object form, same shape the dashboard toast takes:
  // { message, type, duration, undoAction, undoText }. progressStage's
  // required-field block passes one, and this page rendered it as
  // "[object Object]" — the rep never learned which field was missing.
  let duration = null, actionFn = null, actionText = '';
  if (message && typeof message === 'object') {
    const o = message;
    type = o.type || type;
    duration = typeof o.duration === 'number' ? o.duration : null;
    actionFn = typeof o.undoAction === 'function' ? o.undoAction : null;
    actionText = o.undoText || 'Undo';
    message = o.message != null ? o.message : '';
  }
  const DURATIONS = { success: 4000, info: 5000, warning: 7000, error: 9000 };
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    // bottom rides ABOVE the bottom strips (2026-09-25, phone audit). The
    // contract in fab-stack-coordinator.js says toasts ride above
    // --nbd-bottom-chrome, but the only rule that did it is
    // dashboard-app.css's .toast-container margin, and this page loads
    // neither that sheet nor a class on this container. So at bottom:20px
    // every toast landed on #nbd-quick-action-bar (70px tall on a phone):
    // "Job costs saved", "Customer info updated" and every error were
    // hidden behind it, and once the bar dropped under the toast layer the
    // toast would have covered Call / Text / Task for up to 9s instead.
    // --nbd-bottom-chrome is 0px on desktop and wherever no strip shows.
    // --nbd-toast-bottom is customer.html's phone override (<=768px), which
    // also clears the field-tools ⋯ launcher parked above the bar.
    // + --nbd-upload-lift (2026-09-25, phone-audit follow-up from
    // review:chrome): the in-flight upload widget rides the same bottom
    // offset in the same corner, so a toast raised mid-upload landed on its
    // "View details" button for up to 9s (and on desktop too, 16px vs 20px).
    // While the widget shows, customer-bootstrap.module.js publishes its
    // height + an 8px gap here and the stack rises above it; 0px otherwise.
    // right reads --nbd-toast-right (2026-09-25): customer.html's toast
    // lane, which on desktop starts beside the FAB column instead of inside
    // it — lifted above the upload indicator, a toast at right:20px landed
    // on the Quick Capture FAB. 20px on a phone, and wherever it's unset.
    container.style.cssText = 'position:fixed;bottom:calc(var(--nbd-toast-bottom, calc(20px + var(--nbd-bottom-chrome, 0px))) + var(--nbd-upload-lift, 0px));right:var(--nbd-toast-right, 20px);z-index:var(--z-toast);display:flex;flex-direction:column;gap:8px;align-items:flex-end;';
    document.body.appendChild(container);
  }
  while (container.children.length >= 5) container.firstChild.remove();
  const BORDER = { success: 'var(--green,#2ECC8A)', error: 'var(--red,#E05252)', warning: 'var(--gold,#eab308)', info: 'var(--blue,#3b82f6)' };
  const toast = document.createElement('div');
  toast.style.cssText = 'display:flex;align-items:center;gap:10px;background:var(--s,#1a1d23);color:var(--t,#e8eaf0);border:1px solid var(--br,rgba(255,255,255,.1));border-left:3px solid ' + (BORDER[type] || BORDER.info) + ';border-radius:8px;padding:10px 14px;font-size:13px;font-weight:500;box-shadow:0 6px 20px rgba(0,0,0,.25);max-width:min(340px, calc(100vw - 40px));pointer-events:auto;animation:ctToastIn .25s ease-out;';
  const msg = document.createElement('span');
  // A long unbroken token (a URL, a storage path) set the flex item's
  // min-content width and ran the text out past the toast's own edge, over
  // the FAB column (2026-09-25). anywhere, not break-word: only anywhere
  // lowers min-content, which is what lets the item shrink.
  msg.style.cssText = 'min-width:0;overflow-wrap:anywhere;';
  msg.textContent = message;
  const close = document.createElement('button');
  close.type = 'button';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '✕';
  close.style.cssText = 'background:none;border:none;color:var(--m,#8a93a8);cursor:pointer;font-size:12px;padding:2px 4px;flex-shrink:0;';
  close.addEventListener('click', () => toast.remove());
  toast.appendChild(msg);
  if (actionFn) {
    const act = document.createElement('button');
    act.type = 'button';
    act.textContent = actionText;
    act.style.cssText = 'background:none;border:1px solid var(--br,rgba(255,255,255,.2));border-radius:6px;color:var(--orange,#e8720c);cursor:pointer;font-size:12px;font-weight:700;padding:4px 8px;flex-shrink:0;';
    act.addEventListener('click', () => { toast.remove(); try { actionFn(); } catch (_) {} });
    toast.appendChild(act);
  }
  toast.appendChild(close);
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.transition = 'opacity .25s, transform .25s';
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(16px)';
    setTimeout(() => { if (toast.parentNode) toast.remove(); }, 260);
  }, duration || DURATIONS[type] || 5000);
};

// Entry animation keyframes. The slide is 16px, not 40px (and the exit
// 16px, not 30px) since 2026-09-25: on desktop the toast lane now ends 20px
// short of the FAB column (--nbd-toast-right), and a 40px slide carried
// every new toast across that gap and onto the Quick Capture FAB for the
// first quarter-second of its life.
const style = document.createElement('style');
style.textContent = '@keyframes ctToastIn{from{transform:translateX(16px);opacity:0}to{transform:none;opacity:1}}';
document.head.appendChild(style);

// ── Booking Link Copy ─────────────────────────────
window.copyBookingLink = function() {
  const url = window._bookingUrl;
  if (!url) { showToast('No booking link configured', 'error'); return; }
  const name = window._bookingCustomerName;
  // M1 brand parity (customer-bootstrap.module.js pattern): NBD keeps
  // 'Joe from No Big Deal Roofing'; a non-NBD tenant uses its own smsSignOff
  // (or its legalName if unset) — never NBD's name in another company's copy.
  const _b = (window._brand && window._brand()) || {};
  const signOff = _b.smsSignOff || ((!_b.legalName || _b.legalName === 'No Big Deal Home Solutions') ? 'Joe from No Big Deal Roofing' : _b.legalName);
  // The ask follows whichever visit type the rep picked in
  // #bookingKindSelect (set alongside _bookingUrl in
  // customer-bootstrap.module.js); falls back to the inspection wording
  // for any surface that sets _bookingUrl without a kind.
  const ask = window._bookingAsk || 'set up a free roof inspection';
  const text = `Hey${name ? ' ' + name : ''}, this is ${signOff}! I'd love to ${ask} at your convenience. Pick a time that works for you here: ${url}`;
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById('copyBookingBtn');
    if (btn) { btn.textContent = '✅ Copied!'; setTimeout(() => btn.textContent = '📋 Copy Booking Link', 2000); }
    showToast('Booking message copied to clipboard!', 'success');
  }).catch(() => showToast('Failed to copy', 'error'));
};

// ── Tab Navigation (legacy fallback) ──────────
// Tabs were removed in favor of single-page scrollable layout.
// This function now scrolls to the section instead of hiding/showing.
// Kept for backward compat with any code still calling it.
window.switchTab = function(tabName) {
  const target = document.getElementById(tabName + 'Tab');
  if (target) {
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
};

// ── Project Timeline (Milestones) ──────────────────
window.loadProjectTimeline = async function(leadId) {
  try {
    const leadSnap = await window.getDoc(window.doc(window.db, 'leads', leadId));
    if (!leadSnap.exists()) return;

    const lead = leadSnap.data();
    const currentStage = lead.stage || 'new';

    // Define milestone stages with descriptions
    const milestones = [
      { stage: 'new', label: 'Lead Created', icon: '📌', desc: 'New lead in system' },
      { stage: 'contacted', label: 'Contacted', icon: '📞', desc: 'Customer contacted' },
      { stage: 'inspected', label: 'Inspected', icon: '✓', desc: 'Roof inspection done' },
      { stage: 'claim_filed', label: 'Claim Filed', icon: '📋', desc: 'Insurance claim submitted' },
      { stage: 'adjuster_meeting_scheduled', label: 'Adjuster Mtg', icon: '📅', desc: 'Meeting scheduled' },
      { stage: 'adjuster_inspection_done', label: 'Adjuster Done', icon: '✓', desc: 'Adjuster completed review' },
      { stage: 'scope_received', label: 'Scope Received', icon: '📄', desc: 'Scope of work received' },
      { stage: 'estimate_submitted', label: 'Estimate Sent', icon: '💰', desc: 'Estimate sent to customer' }, // was "Estimate Approved" — nothing is approved at this stage
      { stage: 'supplement_requested', label: 'Supplement', icon: '⚙️', desc: 'Additional work requested' },
      { stage: 'supplement_approved', label: 'Supp. Approved', icon: '✓', desc: 'Supplement approved' },
      { stage: 'contract_signed', label: 'Contract Signed', icon: '✍️', desc: 'Customer signed contract' },
      { stage: 'job_created', label: 'Job Created', icon: '🎯', desc: 'Job scheduled' },
      { stage: 'permit_pulled', label: 'Permit', icon: '🔐', desc: 'Building permit obtained' },
      { stage: 'materials_ordered', label: 'Materials Ordered', icon: '📦', desc: 'Materials ordered' },
      { stage: 'materials_delivered', label: 'Materials Here', icon: '🚚', desc: 'Materials on site' },
      { stage: 'crew_scheduled', label: 'Crew Scheduled', icon: '👥', desc: 'Crew scheduled' },
      { stage: 'install_in_progress', label: 'Installing', icon: '🔨', desc: 'Work in progress' },
      { stage: 'install_complete', label: 'Install Done', icon: '✓', desc: 'Installation finished' },
      { stage: 'final_photos', label: 'Final Photos', icon: '📸', desc: 'Final photos taken' },
      { stage: 'deductible_collected', label: 'Deductible', icon: '💳', desc: 'Payment collected' },
      { stage: 'final_payment', label: 'Final Payment', icon: '✓', desc: 'Project paid in full' },
      { stage: 'closed', label: 'Closed', icon: '✅', desc: 'Project complete' }
    ];
    // Labels are the board's own (crm-stages.js STAGE_META via
    // window.stageLabel — tenant renames included). This list carried its
    // own names until 2026-10-03, e.g. Closed read "Warranty Registered".
    // The literals above are the canonical defaults for a stale cache.
    const _canonLabel = (k) => (typeof window.stageLabel === 'function' && window.stageLabel(k)) || '';
    milestones.forEach(m => { const l = _canonLabel(m.stage); if (l) m.label = l; });

    // The list above is the insurance ladder. A cash / finance / warranty /
    // custom-stage lead matched none of it (currentIndex -1 → nothing shown as
    // reached). Use the lead's own track when the page exposes it, keeping
    // the icons/descriptions above for the stages they cover.
    if (typeof window._leadPipelineFor === 'function') {
      const track = window._leadPipelineFor(lead);
      if (Array.isArray(track) && track.length && track.includes(currentStage)) {
        const byKey = {};
        milestones.forEach(m => { byKey[m.stage] = m; });
        const labelOf = (k) => (typeof window.stageLabel === 'function' && window.stageLabel(k)) || k;
        const own = track.map(k => byKey[k] || { stage: k, label: labelOf(k), icon: '•', desc: '' });
        milestones.length = 0;
        own.forEach(m => milestones.push(m));
      }
    }

    // Find current stage index
    const currentIndex = milestones.findIndex(m => m.stage === currentStage);

    // stageHistory is an ARRAY of {from, to, timestamp, user} written by the
    // stage-change handler — it was being read as an object keyed by stage
    // (stageHistory[stage].date), which is always undefined, so NO milestone
    // ever rendered a date. Index it once by destination stage; the FIRST
    // entry wins so a milestone reports when the lead first reached that
    // stage, not the latest re-entry after a bounce-back.
    const stageDates = {};
    (Array.isArray(lead.stageHistory) ? lead.stageHistory : []).forEach(h => {
      if (h && h.to && !(h.to in stageDates)) stageDates[h.to] = h.timestamp;
    });

    let html = '';
    milestones.forEach((milestone, index) => {
      const isCompleted = index < currentIndex;
      const isActive = index === currentIndex;
      const isPending = index > currentIndex;

      const stateClass = isCompleted ? 'completed' : isActive ? 'active' : 'pending';
      // Shared coercion — stageHistory timestamps arrive as Firestore
      // Timestamps, bare {seconds} objects (REST/portal reads) or ISO
      // strings depending on the read path; _nbdTsToDate handles all of
      // them. It's published by loadCustomerData, hence the typeof guard.
      // Registry-only (Globals Tranche 3 T3-C, 2026-09-18), not window.
      var _nbdReg = window.__NBD_CALL_REGISTRY;
      const date = (_nbdReg && typeof _nbdReg._nbdTsToDate === 'function')
        ? _nbdReg._nbdTsToDate(stageDates[milestone.stage])
        : null;
      const dateStr = date ? date.toLocaleDateString() : '';

      html += `
        <div class="milestone ${stateClass}">
          <div class="milestone-dot">${milestone.icon}</div>
          <div class="milestone-content">
            <div class="milestone-title">${nbdEscFn()(milestone.label)}</div>
            ${dateStr ? `<div class="milestone-date">${dateStr}</div>` : ''}
            <div class="milestone-desc">${milestone.desc}</div>
          </div>
        </div>
      `;
    });

    document.getElementById('projectTimeline').innerHTML = html;
  } catch (error) {
    console.error('Timeline load error:', error);
    document.getElementById('projectTimeline').innerHTML = '<div class="empty"><div class="empty-icon">⚠️</div>Failed to load timeline</div>';
  }
};

// ── Recording a payment ─────────────────────────
//
// Until now a rep could not record a check from anywhere in the app once the
// modal that appears immediately after invoice creation was dismissed:
//   - this page's invoice list was READ-ONLY (its "Pay" link is the
//     HOMEOWNER'S Stripe link, not a rep action),
//   - InvoicePipeline.markPaid / markPaidUI ship only on the dashboard, and
//   - renderInvoicePanel and renderInvoiceList — which both carry the right
//     View / Send / Mark Paid buttons — are mounted NOWHERE. Grep across
//     docs/pro finds no caller for either. They are complete, working UIs
//     that were never rendered.
//
// So the money path dead-ended at "customer paid by check" and the invoice
// stayed open forever.

// Lazy-load invoice-pipeline.js (same rules as markPaid below: alias
// window._db, ScriptLoader dedupes) and return its API once `fnName` exists.
async function _nbdInvoicePipeline(fnName) {
  if (!window._db && window.db) window._db = window.db;
  if (!(window.InvoicePipeline && typeof window.InvoicePipeline[fnName] === 'function')) {
    if (!(window.ScriptLoader && typeof window.ScriptLoader.load === 'function')) throw new Error('ScriptLoader unavailable');
    await window.ScriptLoader.load('js/invoice-pipeline.js?v=23');
  }
  if (!(window.InvoicePipeline && typeof window.InvoicePipeline[fnName] === 'function')) {
    throw new Error('InvoicePipeline.' + fnName + ' missing after load');
  }
  return window.InvoicePipeline;
}
//
// invoice-pipeline.js is 82 KB and this page already boots heavy, so it is
// lazy-loaded on the click rather than added to the defer list. ScriptLoader
// is already on this page, resolves immediately if the file is present, and
// dedupes concurrent calls.
window.NBDCustomerInvoices = {
  // Record payment (2026-10-03): ONE sheet for money that came in on this
  // job — check, Zelle, cash, card or ACH outside Stripe — whether or not
  // the job has an invoice yet (invoice-pipeline.js recordPaymentUI makes it
  // from the estimate, else from the job total the rep confirms).
  recordPayment: async function (leadId) {
    leadId = leadId || window._customerId;
    if (!leadId) return;
    try {
      const IP = await _nbdInvoicePipeline('recordPaymentUI');
      const paid = await IP.recordPaymentUI(leadId);
      const reload = window.loadInvoices;
      if (paid && typeof reload === 'function') await reload(leadId);
    } catch (err) {
      console.error('[invoices] recordPayment failed', err);
      if (typeof window.showToast === 'function') window.showToast('Could not open the payment form. Reload and try again.', 'error');
    }
  },
  // "Send receipt" (2026-10-04): ONE tap sends that payment's drafted
  // receipt — email with leadId + invoiceId (the #2120 recipient binding),
  // or the share sheet with no email on file. Recording a payment never
  // emails anyone; this tap is the only way a receipt goes out.
  sendReceipt: async function (invoiceId, key) {
    if (!invoiceId || !key) return;
    try {
      const IP = await _nbdInvoicePipeline('sendReceiptUI');
      const sent = await IP.sendReceiptUI(invoiceId, key);
      if (sent) {
        const leadId = window._customerId;
        const reloadInv = window.loadInvoices;
        const reloadTl = window.loadTimeline;
        if (typeof reloadInv === 'function' && leadId) await reloadInv(leadId);
        if (typeof reloadTl === 'function' && leadId && window._currentLead) await reloadTl(leadId, window._currentLead);
      }
    } catch (err) {
      console.error('[invoices] sendReceipt failed', err);
      if (typeof window.showToast === 'function') window.showToast('Could not send the receipt. Reload and try again.', 'error');
    }
  },
  // "Send balance" on a part-paid invoice: the existing send sheet (email /
  // text / portal) — one tap to choose, nothing goes out on its own.
  sendBalance: async function (invoiceId) {
    if (!invoiceId) return;
    try {
      const IP = await _nbdInvoicePipeline('sendInvoiceUI');
      await IP.sendInvoiceUI(invoiceId);
      const reload = window.loadInvoices;
      if (typeof reload === 'function' && window._customerId) await reload(window._customerId);
    } catch (err) {
      console.error('[invoices] sendBalance failed', err);
      if (typeof window.showToast === 'function') window.showToast('Could not open the send form. Reload and try again.', 'error');
    }
  },
  // "Draft deposit — review & send" (2026-10-03): the draft deposit invoice
  // the server made when the contract was signed. Opens the invoice detail
  // (invoice-pipeline.js showInvoiceDetailModal), whose Send to Customer
  // button is the existing send flow — nothing here sends anything.
  review: async function (invoiceId) {
    if (!invoiceId) return;
    try {
      // Same lazy load as markPaid below (window._db alias + ScriptLoader).
      if (!window._db && window.db) window._db = window.db;
      if (!(window.InvoicePipeline && typeof window.InvoicePipeline.showInvoiceDetailModal === 'function')) {
        if (!(window.ScriptLoader && typeof window.ScriptLoader.load === 'function')) throw new Error('ScriptLoader unavailable');
        await window.ScriptLoader.load('js/invoice-pipeline.js?v=23');
      }
      if (!(window.InvoicePipeline && typeof window.InvoicePipeline.showInvoiceDetailModal === 'function')) {
        throw new Error('InvoicePipeline.showInvoiceDetailModal missing after load');
      }
      window.InvoicePipeline.showInvoiceDetailModal(invoiceId);
    } catch (err) {
      console.error('[invoices] review failed', err);
      if (typeof window.showToast === 'function') window.showToast('Could not open the invoice. Reload and try again.', 'error');
    }
  },
  markPaid: async function (invoiceId) {
    if (!invoiceId) return;
    try {
      // invoice-pipeline.js was written for the dashboard, whose bootstrap
      // sets BOTH window.db and window._db to the same Firestore instance
      // (dashboard-bootstrap.module.js:1171 and :1175). This page sets only
      // window.db, so the module's getDb() — which checks window._db — throws
      // "Firestore (v9) not initialized" the moment Mark Paid is tapped.
      // Alias the same instance rather than editing the module: it is the
      // identical object on the dashboard, so nothing there changes.
      if (!window._db && window.db) window._db = window.db;
      if (!(window.InvoicePipeline && typeof window.InvoicePipeline.markPaidUI === 'function')) {
        if (!(window.ScriptLoader && typeof window.ScriptLoader.load === 'function')) {
          throw new Error('ScriptLoader unavailable');
        }
        await window.ScriptLoader.load('js/invoice-pipeline.js?v=23');
      }
      if (!(window.InvoicePipeline && typeof window.InvoicePipeline.markPaidUI === 'function')) {
        throw new Error('InvoicePipeline.markPaidUI missing after load');
      }
      // markPaidUI now settles when the PAYMENT settles, not when its modal
      // opens (invoice-pipeline.js). The previous `setTimeout(..., 600)` fired
      // 600ms after the overlay appeared — while the rep was still typing the
      // amount — so it repainted the still-unpaid row and nothing repainted
      // afterwards: the post-write refresh in markPaidUI targets
      // #nbd-inv-detail-host, which is a DASHBOARD host and does not exist on
      // this page. The check was recorded and the row kept saying unpaid.
      const paid = await window.InvoicePipeline.markPaidUI(invoiceId);
      // Repaint only on a real write. A cancel leaves the row correct already,
      // and repainting then would just cost a read set.
      if (paid && typeof window.loadInvoices === 'function' && window._customerId) {
        await window.loadInvoices(window._customerId);
      }
    } catch (err) {
      console.error('[invoices] markPaid failed', err);
      if (typeof window.showToast === 'function') {
        window.showToast('Could not open the payment form. Reload and try again.', 'error');
      }
    }
  },
};

// ── Invoices & Payments ─────────────────────────
window.loadInvoices = async function(leadId) {
  // #2112's owed rule, copied byte-for-byte from collected-revenue.js
  // (that file is not loaded on this page); pinned by
  // tests/deposit-draft-2026-10-03.test.js. Function-local: no new globals.
  // nbd:owed-rule:start — ONE "is this invoice still owed?" rule, kept
  // byte-identical in collected-revenue.js, money-dashboard.js,
  // analytics-kpi.js and invoice-pipeline.js
  // (tests/invoice-owed-rule-2026-10-03.test.js). A voided Stripe mirror is
  // written { status:'void', balanceDue:0 }; drafts were never sent. Neither
  // is owed. Amount = balanceDue when present (0 means nothing due — the old
  // `balanceDue || total` read 0 as "missing" and re-counted the full face).
  var NOT_OWED_STATUS = { paid: 1, draft: 1, cancelled: 1, canceled: 1, void: 1, voided: 1, uncollectible: 1 };
  function isOwedInvoice(inv) {
    if (!inv || inv.deleted === true) return false;
    return !NOT_OWED_STATUS[String(inv.status || '').toLowerCase()];
  }
  function owedDollarsOf(inv) {
    if (!isOwedInvoice(inv)) return 0;
    var b = inv.balanceDue;
    var v = parseFloat((b != null && b !== '') ? b : inv.total);
    return v > 0 ? v : 0;
  }
  // nbd:owed-rule:end
  try {
    const uid = window.auth?.currentUser?.uid || window._user?.uid;
    if (!uid || !window.db) {
      document.getElementById('invoiceList').innerHTML = '<div class="empty"><div class="empty-icon">💰</div>No invoices yet</div>';
      return;
    }
    // Team visibility (mirrors loadCommunicationLog + the /invoices rule):
    // company_admin/manager/viewer with a companyId read the whole tenant's
    // invoices for this lead; everyone else reads their own. Invoice docs are
    // stamped `createdAt` (never `date`) + `companyId` by invoice-pipeline, so
    // the old orderBy('date') silently dropped EVERY invoice (Firestore skips
    // docs missing the sort field) — sort createdAt client-side instead. Both
    // branches are two equality filters (no composite index; single-field
    // merge-join), so no index deploy is required.
    const claims = window._userClaims || {};
    const role = claims.role || '';
    const companyId = claims.companyId || null;
    const teamScope = !!(companyId && (role === 'company_admin' || role === 'manager' || role === 'viewer' || claims.owner === true));
    const invoicesRef = window.collection(window.db, 'invoices');
    const q = teamScope
      ? window.query(invoicesRef, window.where('leadId', '==', leadId), window.where('companyId', '==', companyId))
      : window.query(invoicesRef, window.where('leadId', '==', leadId), window.where('createdBy', '==', uid));
    const snap = await window.getDocs(q);

    const tsMs = (v) => (v && v.toDate ? v.toDate().getTime() : (v ? new Date(v).getTime() : 0)) || 0;
    const invoices = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => tsMs(b.createdAt) - tsMs(a.createdAt));

    const esc = window.nbdEsc || (s => String(s == null ? '' : s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])));
    // Record payment (2026-10-03): money in on this job, invoice or not —
    // the only way to log a check / Zelle / cash on a job with no invoice.
    const recordBtn = '<button type="button" class="btn btn-orange ipx-rp-open" data-rp-open'
      + ' data-action="NBDCustomerInvoices.recordPayment" data-arg="' + esc(leadId) + '">💵 Record payment</button>';

    if (!invoices.length) {
      document.getElementById('invoiceList').innerHTML = recordBtn + '<div class="empty"><div class="empty-icon">💰</div>No invoices yet</div>';
      return;
    }

    // 'partial' = part paid (Stripe ledger + Record Payment). It was missing,
    // so a part-paid invoice rendered as "draft".
    const ALLOWED_STATUSES = new Set(['draft','sent','viewed','partial','paid','overdue','cancelled']);
    // Invoices the Stripe ledger created (source:'stripe') get a "From Stripe"
    // chip + Open in Stripe / PDF links (stripe-ledger-ui-logic.js, escaped
    // and http(s)-only). '' when the rules module is absent.
    const stripeBadge = (inv) => (window.NBDStripeLedgerLogic ? window.NBDStripeLedgerLogic.stripeInvoiceBadgeHtml(inv) : '');
    let totalAmount = 0;
    let totalPaid = 0;
    // Total Owed counts only invoices someone owes (owedDollarsOf above): not
    // a draft (never sent — incl. the draft deposit invoice the server makes
    // on a signed contract), void, cancelled or deleted.
    let totalOwed = 0;
    const isDepositDraft = (inv) => !!(inv && inv.status === 'draft' && inv.autoDraft && inv.autoDraft.kind === 'deposit_on_sign');
    // Receipts (2026-10-04): every payment has a DRAFT receipt until the rep
    // taps Send receipt — nothing is emailed when money is recorded. Same
    // rules as invoice-pipeline.js receiptStateOf / receiptKeyOf (that file
    // is lazy-loaded here, so the two small rules are inlined).
    const _payIdOf = (p) => String((p && (p.paymentId || p.paymentIntentId || p.stripeRef)) || '');
    const receiptBtns = (inv) => {
      const pays = Array.isArray(inv.payments) ? inv.payments : [];
      const drafts = [];
      pays.forEach((p, i) => {
        if (!p || !(Number(p.amount) > 0) || p.achStatus === 'failed' || p.reverted === true) return;
        if (p.receipt && p.receipt.status === 'sent') return;
        drafts.push({ key: _payIdOf(p) || ('idx:' + i), amount: Number(p.amount) });
      });
      return drafts.map((r) => '<button type="button" class="doc-btn ipx-send-receipt" data-send-receipt'
        + ' data-action="NBDCustomerInvoices.sendReceipt" data-arg="' + esc(inv.id) + '" data-arg2="' + esc(r.key) + '"'
        + ' title="Email this payment\'s receipt to the customer">Send receipt'
        + (drafts.length > 1 ? ' ($' + r.amount.toLocaleString('en-US', { minimumFractionDigits: 2 }) + ')' : '') + '</button>').join('');
    };
    // A bank payment (ACH) in flight: shown, never counted as paid.
    const achPendingHtml = (inv) => {
      const p = inv && inv.achPending;
      if (!p || !(Number(p.amountCents) > 0)) return '';
      return '<div class="invoice-paynote" data-ach-pending>Bank payment $' + (Number(p.amountCents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })
        + ' processing — not paid until it clears</div>';
    };
    const _J = window.NBDJurisdiction;
    const _payLead = (window._currentLead && typeof window._currentLead === 'object'
      && (!window._customerId || window._customerId === leadId)) ? window._currentLead : null;
    let html = recordBtn;

    invoices.forEach(inv => {
      // invoice-pipeline writes `total` (never `amount` — that legacy key
      // rendered every pipeline invoice as $0.00 here). Paid cash = the
      // invoice's own collected math (total − balanceDue), NOT a
      // status==='paid' gate: a deposit on an open invoice is real money
      // and must agree with the invoice's balanceDue and the Money
      // dashboard, not show Total Paid $0.00 until full payoff.
      const amount = parseFloat(inv.total != null ? inv.total : inv.amount) || 0;
      const bal = (inv.balanceDue != null) ? (parseFloat(inv.balanceDue) || 0) : (inv.status === 'paid' ? 0 : amount);
      const paidCash = Math.max(0, amount - bal);

      totalAmount += amount;
      totalPaid += paidCash;
      totalOwed += owedDollarsOf(inv);
      const depDraft = isDepositDraft(inv);

      const safeStatus = ALLOWED_STATUSES.has(inv.status) ? inv.status : 'draft';
      // The pay link is stripePaymentLink (a CRM payment link) OR
      // stripeHostedUrl (a Stripe Invoice — every invoice the ledger mirrors
      // in); this read only the first, so no Stripe invoice ever showed Pay.
      // ky-insurance-law.js payUrlUnlessHeld reads both and returns '' while
      // the Kentucky insurance hold applies (KRS 367.626). FAIL CLOSED: no
      // jurisdiction module or no lead on the page → no Pay button.
      const safePayUrl = (_J && typeof _J.payUrlUnlessHeld === 'function' && _payLead)
        ? (_J.payUrlUnlessHeld(_payLead, inv, new Date(), _J.resolveTimeZone(typeof window._legal === 'function' ? window._legal() : (window._companyProfile || {}))) || null) : null;
      // Invoices are stamped `createdAt`; fall back to a legacy `date` if any
      // old doc carried one. Guard against an unparseable value so a single bad
      // row can't render "Invalid Date".
      const rawDate = inv.createdAt || inv.date;
      const d = rawDate && rawDate.toDate ? rawDate.toDate() : (rawDate ? new Date(rawDate) : null);
      const dateStr = (d && !isNaN(d.getTime())) ? d.toLocaleDateString() : '';
      html += `
        <div class="invoice-item${depDraft ? ' is-deposit-draft' : ''}">
          <div class="invoice-left">
            <div class="invoice-date">${esc(dateStr)}</div>
            <div class="invoice-desc">${esc(inv.description || 'Invoice')}</div>
            ${stripeBadge(inv)}
            ${depDraft ? '<span class="ipx-draft-chip" data-deposit-draft>Draft deposit — review &amp; send</span>' : ''}
          </div>
          <div class="invoice-right">
            <div class="invoice-amount">$${amount.toLocaleString('en-US', {minimumFractionDigits: 2})}</div>
            <div class="invoice-status ${safeStatus}">${safeStatus}</div>
            ${bal > 0 && bal < amount ? `<div class="invoice-owed">$${bal.toLocaleString('en-US', {minimumFractionDigits: 2})} owed</div>` : ''}
            ${depDraft ? `
              <button type="button" class="doc-btn" data-action="NBDCustomerInvoices.review" data-arg="${esc(inv.id)}"
                      title="Open the draft, check it, then Send">Review &amp; send</button>
            ` : ''}
            ${safeStatus !== 'paid' && safePayUrl ? `
              <a href="${esc(safePayUrl)}" target="_blank" rel="noopener noreferrer" class="doc-btn">Pay</a>
              ${(typeof window._isNbdPlatformTenant === 'function' && window._isNbdPlatformTenant() === true) ? '<div class="invoice-paynote" data-pay-by-bank>Pay by bank (ACH) — lower fees</div>' : ''}
            ` : ''}
            ${achPendingHtml(inv)}
            ${receiptBtns(inv)}
            ${safeStatus !== 'paid' ? `
              <button type="button" class="doc-btn" data-action="NBDCustomerInvoices.markPaid" data-arg="${esc(inv.id)}"
                      title="Record a check or cash payment">Mark Paid</button>
            ` : ''}
            ${(safeStatus !== 'paid' && safeStatus !== 'draft' && safeStatus !== 'cancelled' && bal > 0 && bal < amount) ? `
              <button type="button" class="doc-btn ipx-send-balance" data-send-balance data-action="NBDCustomerInvoices.sendBalance" data-arg="${esc(inv.id)}"
                      title="Send the remaining balance — you pick email, text or portal">Send balance</button>
            ` : ''}
          </div>
        </div>
      `;
    });

    html += `
      <div class="payment-summary">
        <div class="summary-item">
          <div class="summary-label">Total Owed</div>
          <div class="summary-value">$${totalOwed.toLocaleString('en-US', {minimumFractionDigits: 2})}</div>
        </div>
        <div class="summary-item">
          <div class="summary-label">Total Paid</div>
          <div class="summary-value">$${totalPaid.toLocaleString('en-US', {minimumFractionDigits: 2})}</div>
        </div>
      </div>
    `;

    document.getElementById('invoiceList').innerHTML = html;
    window.nbdTitleCount('invoicesPanelTitle', 'Invoices & Payments', invoices.length);
  } catch (error) {
    console.error('Invoice load error:', error);
    document.getElementById('invoiceList').innerHTML = '<div class="empty"><div class="empty-icon">⚠️</div>Failed to load invoices</div>';
  }
};

// ── Photos by Phase ─────────────────────────────
window._allPhotos = [];
// Empty, not 'During'. Nothing on this page can set it: the upload modal
// (customer.html) is a drop zone, a preview strip and an Upload button —
// #uploadPhaseButtons, #uploadMetaSection, #uploadDamageType and
// #uploadLocation were never written in ANY commit (git log --all -S on each
// returns nothing), and the two selectors that drove them had zero callers.
// So the default WAS the value, and 'During' meant every uploaded photo
// arrived claiming to be sorted. Deleted the dead selectors with it.
window._uploadPhase = '';
window._photoFilter = 'all';

window.filterPhotos = function(filter, btn) {
  document.querySelectorAll('.photo-filter-btn').forEach(function(b){ b.classList.remove('active'); });
  if (btn) btn.classList.add('active');
  window._photoFilter = filter;
  renderPhotoGrid();
};

// Default cap per phase. Joe's biggest leads (e.g. McCane's 80+ photos)
// were unscrollable because every phase rendered all photos at once.
// "Show all" button toggles the per-phase _phaseExpanded flag.
var PHOTO_PHASE_CAP = 25;
window._phaseExpanded = window._phaseExpanded || { 'Before': false, 'During': false, 'After': false };

function nbdEscFn() {
  return window.nbdEsc || function(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]});};
}

// ── /photos.damageType canon ───────────────────────────────────
// This page wrote TWO of the four historical damageType vocabularies: the
// quick-edit popup below (Title Case: 'Hail', 'Flashing', 'Gutter') and the
// bulk bar in customer.html (kebab: 'granule-loss', 'missing-shingles').
// Neither matched Review & Sort or the AI classifier, so photos of one peril
// tagged on different surfaces never grouped in the photo report's
// before/after pairing. docs/pro/js/photo-damage-types.js owns the fold;
// resolved per call so a script-order change degrades labels, not the page.
function _dmgNorm(v) {
  var D = window.NBD_PHOTO_DAMAGE;
  return D ? D.normalize(v) : String(v == null ? '' : v).trim();
}
function _dmgLabel(v) {
  var D = window.NBD_PHOTO_DAMAGE;
  return D ? D.label(v) : String(v == null ? '' : v);
}
function _dmgOptions() {
  var D = window.NBD_PHOTO_DAMAGE;
  return D ? D.options() : [['hail', 'Hail'], ['wind', 'Wind'], ['leak', 'Leak'], ['other', 'Other']];
}

function buildPhotoBadges(photo, esc) {
  var badges = '';
  if (photo.damageType) badges += '<span class="nbd-photo-badge ct-badge ct-badge-orange">' + esc(_dmgLabel(photo.damageType)) + '</span>';
  if (photo.severity) {
    var sc = photo.severity === 'severe' ? 'var(--red)' : photo.severity === 'moderate' ? 'var(--orange)' : 'var(--gold)';
    badges += '<span class="nbd-photo-badge" style="font-size:9px;padding:1px 5px;border-radius:4px;background:color-mix(in srgb, ' + sc + ' 20%, transparent);color:' + sc + ';text-transform:capitalize;">' + esc(photo.severity) + '</span>';
  }
  if (photo.isAnnotated) badges += '<span class="nbd-photo-badge ct-badge ct-badge-purple">Annotated</span>';
  // Homeowner-share badge — clickable. data-action triggers the
  // delegated handler in attachCustomerPhotoStripHandlers /
  // wirePhotoGridDelegate to flip sharedWithHomeowner via
  // updateDoc. Visual states:
  //   - shared:   solid green pill with "Shared"
  //   - unshared: ghost pill with "Share" (subtle, doesn't compete
  //               with damage/severity tags)
  if (photo.sharedWithHomeowner) {
    badges += '<button type="button" class="nbd-photo-badge nbd-share-toggle ct-badge ct-badge-shared" data-action="toggleHomeownerShare" data-arg="' + esc(photo.id) + '">✓ Shared</button>';
  } else {
    badges += '<button type="button" class="nbd-photo-badge nbd-share-toggle ct-badge ct-badge-share" data-action="toggleHomeownerShare" data-arg="' + esc(photo.id) + '">Share</button>';
  }
  return badges;
}

// Toggle the homeowner-shared flag on a single photo. Optimistic
// update: flip local state + repaint the badge before the network
// round-trip; revert if Firestore rejects. The badge sits inside
// the tile click target, so the delegated photo-grid click handler
// must let "toggle-share" through without opening the lightbox.
window.toggleHomeownerShare = async function (photoId) {
  if (!photoId) return;
  var byId = window._photoById;
  var photo = byId && byId.get ? byId.get(photoId) : null;
  if (!photo) return;
  var prev = !!photo.sharedWithHomeowner;
  photo.sharedWithHomeowner = !prev;
  if (typeof updatePhotoTile === 'function') updatePhotoTile(photoId);

  if (!window.updateDoc || !window.doc || !window.db) return;
  try {
    await window.updateDoc(window.doc(window.db, 'photos', photoId), {
      sharedWithHomeowner: photo.sharedWithHomeowner
    });
    if (window.showToast) {
      window.showToast(photo.sharedWithHomeowner ? '✓ Shared with homeowner' : 'Removed from homeowner share', 'success');
    }
  } catch (err) {
    // Revert on failure so the UI reflects ground truth.
    photo.sharedWithHomeowner = prev;
    if (typeof updatePhotoTile === 'function') updatePhotoTile(photoId);
    console.error('toggleHomeownerShare failed:', err);
    if (window.showToast) window.showToast('Could not update share state', 'error');
  }
};

// Build the responsive image attributes for a photo. When the
// image-pipeline Cloud Function has stamped `urls: {thumb,med,full}`,
// emit `srcset` so the browser pulls the 200/600/1600 variant that
// matches the rendered cell — saving 90%+ bandwidth on a typical
// thumbnail grid (3-5 MB iPhone JPEG → ~15 KB WebP thumb).
//
// Pre-pipeline photos lack `urls`. They render from the original
// `url` and skip srcset entirely so the browser doesn't waste a
// fetch on a non-existent variant. The pipeline backfill migration
// (queued under Joe-action #19) will stamp legacy docs over time.
//
// `sizes` is the cell width hint for the browser. Default '180px'
// matches the typical phase-grid + overview-strip tile width on
// mobile; callers pass a different hint when rendering bigger
// surfaces (lightbox, photo report).
function buildPhotoImgAttrs(photo, esc, opts) {
  var sizes = (opts && opts.sizes) || '180px';
  var primary = /^https?:/i.test(String(photo.url || '')) ? photo.url : '';
  var urls = photo && photo.urls;
  var hasVariants = urls && /^https?:/i.test(String(urls.thumb || '')) &&
                    /^https?:/i.test(String(urls.med || '')) &&
                    /^https?:/i.test(String(urls.full || ''));
  if (!hasVariants) {
    return 'src="' + esc(primary) + '"';
  }
  var srcset = esc(urls.thumb) + ' 200w, ' +
               esc(urls.med)   + ' 600w, ' +
               esc(urls.full)  + ' 1600w';
  // src= falls back to the medium variant for browsers that don't
  // honor srcset; primary `url` is kept as the ultimate fallback
  // for clients that pre-date the pipeline.
  var fallback = esc(urls.med || primary);
  return 'src="' + fallback + '" srcset="' + srcset + '" sizes="' + esc(sizes) + '"';
}
window.buildPhotoImgAttrs = buildPhotoImgAttrs;

function buildPhotoTile(photo, esc) {
  var imgAttrs = buildPhotoImgAttrs(photo, esc, { sizes: '180px' });
  var badges = buildPhotoBadges(photo, esc);
  var selected = window._photoSelected && window._photoSelected.has(photo.id);
  var classes = 'photo-item nbd-phase-photo' + (selected ? ' is-selected' : '');
  var tile = '<div class="' + classes + ' ct-tile" data-photo-id="' + esc(photo.id) + '">';
  tile += '<span class="nbd-photo-checkbox" aria-hidden="true"></span>';
  tile += '<img ' + imgAttrs + ' alt="Photo" referrerpolicy="no-referrer" loading="lazy" decoding="async" class="ct-cover">';
  tile += '<div class="nbd-photo-badge-row" style="position:absolute;bottom:0;left:0;right:0;padding:4px 6px;background:linear-gradient(transparent,rgba(0,0,0,.7));display:' + (badges ? 'flex' : 'none') + ';flex-wrap:wrap;gap:2px;">' + badges + '</div>';
  tile += '</div>';
  return tile;
}

// Surgically patch a single tile's badges + (optionally) image src in
// place. No full grid re-render. Phase changes still need a full
// re-render because the tile lives in a different phase section —
// quickSaveMeta detects that case.
function updatePhotoTile(photoId) {
  var photo = window._photoById && window._photoById.get(photoId);
  if (!photo) return;
  var tile = document.querySelector('.nbd-phase-photo[data-photo-id="' + (window.CSS && CSS.escape ? CSS.escape(photoId) : photoId) + '"]');
  if (!tile) return; // tile not in current view (filtered out or phase collapsed)
  var badgeRow = tile.querySelector('.nbd-photo-badge-row');
  if (!badgeRow) return;
  var esc = nbdEscFn();
  var badges = buildPhotoBadges(photo, esc);
  badgeRow.innerHTML = badges;
  badgeRow.style.display = badges ? 'flex' : 'none';
}

window.toggleShowAllPhase = function(phase) {
  window._phaseExpanded[phase] = !window._phaseExpanded[phase];
  renderPhotoGrid();
};

// ── Multi-select state + helpers ──────────────────────────
// _photoSelected is a Set of selected photo ids. Selection mode is
// driven by the body.nbd-photo-selecting class so CSS can show the
// checkbox overlay on every tile. Tiles already in the Set keep
// their is-selected class even outside selection mode (so the user
// can deselect after exiting).
//
// Migration to NBDStore: this slice is now stored at
// `photos.selected` in the shared store. window._photoSelected
// stays mirrored (one-way) via store.bind for legacy reads.
// Subscribers can listen for selection changes without coupling
// to updateBulkBarUI directly:
//
//     NBDStore.subscribe('photos.selected', set => render(set));
if (window.NBDStore) {
  window.NBDStore.set('photos.selected', new Set());
  window.NBDStore.bind('_photoSelected', 'photos.selected');
  // Re-emit selection changes onto a UI hook so the bulk bar
  // re-renders without the call sites needing to know about it.
  window.NBDStore.subscribe('photos.selected', function () {
    if (typeof updateBulkBarUI === 'function') updateBulkBarUI();
  });
} else {
  window._photoSelected = window._photoSelected || new Set();
}

function isPhotoSelectMode() {
  return document.body.classList.contains('nbd-photo-selecting');
}

// Mutate the selection Set and republish it to the store so
// subscribers (including the bulk bar) get notified. The store's
// notify path uses identity equality, so we have to swap the Set
// reference rather than mutate-in-place — otherwise the listener
// never fires.
function updatePhotoSelection(mutate) {
  var prev = (window.NBDStore && window.NBDStore.get('photos.selected')) || window._photoSelected || new Set();
  var next = new Set(prev);
  mutate(next);
  if (window.NBDStore) {
    window.NBDStore.set('photos.selected', next);
  } else {
    window._photoSelected = next;
    if (typeof updateBulkBarUI === 'function') updateBulkBarUI();
  }
}

function updateBulkBarUI() {
  var bar = document.getElementById('nbdPhotoBulkBar');
  var count = document.getElementById('nbdPhotoBulkCount');
  var sel = (window.NBDStore && window.NBDStore.get('photos.selected')) || window._photoSelected;
  var n = sel ? sel.size : 0;
  if (bar) bar.classList.toggle('active', n > 0);
  if (count) count.textContent = n + ' selected';
  // Reflect select-mode entry/exit on the toggle button label.
  var toggle = document.getElementById('nbdPhotoSelectToggle');
  if (toggle) toggle.textContent = isPhotoSelectMode() ? 'Done' : 'Select';
}

function togglePhotoSelection(photoId) {
  updatePhotoSelection(function (next) {
    if (next.has(photoId)) next.delete(photoId);
    else next.add(photoId);
  });
  // Surgical: just flip the is-selected class on the tile in place.
  var sel = (window.NBDStore && window.NBDStore.get('photos.selected')) || window._photoSelected;
  var tile = document.querySelector('.nbd-phase-photo[data-photo-id="' + (window.CSS && CSS.escape ? CSS.escape(photoId) : photoId) + '"]');
  if (tile) tile.classList.toggle('is-selected', sel && sel.has(photoId));
  // updateBulkBarUI runs via the store subscriber when NBDStore is
  // present — fall back to a manual call only if the store didn't
  // load (e.g. CSP block, cache miss).
  if (!window.NBDStore) updateBulkBarUI();
}

window.togglePhotoSelectMode = function() {
  var entering = !isPhotoSelectMode();
  document.body.classList.toggle('nbd-photo-selecting', entering);
  if (!entering) {
    // Leaving select mode WITHOUT clearing — selected photos stay
    // selected so a stray tap doesn't lose work. Use the bar's
    // Cancel button to clear the selection.
  }
  updateBulkBarUI();
};

window.exitPhotoSelectMode = function() {
  // Clear the entire selection + leave select mode.
  var prev = (window.NBDStore && window.NBDStore.get('photos.selected')) || window._photoSelected;
  if (prev && prev.size) {
    var toClear = Array.from(prev);
    updatePhotoSelection(function (next) { next.clear(); });
    toClear.forEach(function(id){
      var t = document.querySelector('.nbd-phase-photo[data-photo-id="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
      if (t) t.classList.remove('is-selected');
    });
  }
  document.body.classList.remove('nbd-photo-selecting');
  if (!window.NBDStore) updateBulkBarUI();
};

// Bulk Firestore update via writeBatch — up to 500 ops per round-trip.
// One network call instead of N. After commit, surgically patches
// each affected tile (or falls back to a full re-render when the
// phase changed, since tiles move between phase sections).
window.applyBulkPhotoUpdate = async function(field, rawValue) {
  if (!field || !rawValue) return;
  if (!window._photoSelected || window._photoSelected.size === 0) return;
  if (!window.writeBatch || !window.db || !window.doc) return;
  // Sentinel value used by the dropdowns to clear a field.
  var value = rawValue === '__clear__' ? '' : rawValue;
  // Normalize on write. The bulk bar's option values are canonical ids now,
  // but a stale cached customer.html would still send the old kebab ones.
  if (field === 'damageType') value = _dmgNorm(value);
  var ids = Array.from(window._photoSelected);
  var phaseChanged = false;

  try {
    var batch = window.writeBatch(window.db);
    var update = {};
    update[field] = value;
    for (var i = 0; i < ids.length; i++) {
      var ref = window.doc(window.db, 'photos', ids[i]);
      batch.update(ref, update);
    }
    await batch.commit();

    // Mirror writes into _allPhotos / _photoById and surgical-update
    // each tile. Track whether any phase moved — if so we re-render
    // because tiles live in a different phase section.
    for (var j = 0; j < ids.length; j++) {
      var p = window._photoById && window._photoById.get(ids[j]);
      if (!p) continue;
      if (field === 'phase' && p.phase !== value) phaseChanged = true;
      p[field] = value;
    }
    updatePhotoStats();
    if (phaseChanged) {
      renderPhotoGrid();
    } else {
      ids.forEach(function(id){ updatePhotoTile(id); });
    }

    if (window.showToast) {
      window.showToast('✓ Updated ' + ids.length + ' photo' + (ids.length === 1 ? '' : 's'), 'success');
    }
  } catch (err) {
    console.error('Bulk photo update failed:', err);
    if (window.showToast) window.showToast('Bulk update failed: ' + (err && err.message || 'unknown error'), 'error');
  }
};

window.applyBulkPhotoDelete = async function() {
  if (!window._photoSelected || window._photoSelected.size === 0) return;
  if (!window.writeBatch || !window.db || !window.doc || !window.deleteDoc) return;
  var ids = Array.from(window._photoSelected);
  // native confirm() is patched to silently return true in PWA mode
  // (standalone-compat.js), so route through nbdConfirm to get a real Cancel.
  var ask = window.nbdConfirm || function(m){ return Promise.resolve(window.confirm(m)); };
  if (!(await ask('Delete ' + ids.length + ' photo' + (ids.length === 1 ? '' : 's') + '? This cannot be undone.'))) return;
  try {
    var batch = window.writeBatch(window.db);
    for (var i = 0; i < ids.length; i++) {
      batch.delete(window.doc(window.db, 'photos', ids[i]));
    }
    await batch.commit();

    // Drop from local state.
    var idSet = new Set(ids);
    window._allPhotos = (window._allPhotos || []).filter(function(p){ return !idSet.has(p.id); });
    if (window._photoById) ids.forEach(function(id){ window._photoById.delete(id); });
    updatePhotoSelection(function (next) { next.clear(); });
    document.body.classList.remove('nbd-photo-selecting');

    updatePhotoStats();
    renderPhotoGrid();
    if (!window.NBDStore) updateBulkBarUI();
    // Registry-only (Globals Tranche 3 T3-C, 2026-09-18), not a bare
    // reference — this is a classic script, loadPhotos is module-scoped in
    // customer-bootstrap.module.js and only reachable via the registry
    // (2026-09-17: the bare form here threw ReferenceError, silently
    // swallowed below, so #photoList never actually refreshed after a
    // delete until that fix).
    try { await window.__NBD_CALL_REGISTRY.loadPhotos(window._customerId); } catch(e) {}

    if (window.showToast) window.showToast('✓ Deleted ' + ids.length + ' photo' + (ids.length === 1 ? '' : 's'), 'success');
  } catch (err) {
    console.error('Bulk photo delete failed:', err);
    if (window.showToast) window.showToast('Bulk delete failed: ' + (err && err.message || 'unknown error'), 'error');
  }
};

// Single delegated click listener for the whole photo grid. Attached
// once and reused — re-renders don't re-bind.
function ensurePhotoGridDelegate() {
  var grid = document.getElementById('photosByPhase');
  if (!grid || grid.dataset.nbdDelegated === '1') return;
  grid.dataset.nbdDelegated = '1';
  grid.addEventListener('click', function(ev) {
    // Share-with-homeowner toggle — bubbles up from the badge
    // button. Must run BEFORE the lightbox/select branches so a
    // tap on the Share pill doesn't open the editor.
    // Match by class (not the action name) so this keeps intercepting the badge
    // BEFORE the lightbox even though the badge's data-action is now the real
    // global (toggleHomeownerShare) + data-arg — which also lets the generic
    // customer.html delegate handle the SAME badge when it's rendered outside
    // this #photosByPhase grid (previously dead: hyphenated 'toggle-share' had
    // no window handler).
    var shareBtn = ev.target.closest('.nbd-share-toggle');
    if (shareBtn && shareBtn.dataset.arg) {
      ev.preventDefault();
      ev.stopPropagation();
      window.toggleHomeownerShare(shareBtn.dataset.arg);
      return;
    }
    // Show-all toggle inside a phase header.
    var toggleBtn = ev.target.closest('.nbd-show-all-btn');
    if (toggleBtn && toggleBtn.dataset.phase) {
      ev.preventDefault();
      window.toggleShowAllPhase(toggleBtn.dataset.phase);
      return;
    }
    // Photo tile click.
    var tile = ev.target.closest('.nbd-phase-photo');
    if (!tile) return;
    var photoId = tile.dataset.photoId;
    var photo = window._photoById && window._photoById.get(photoId);
    if (!photo) return;
    // Selection mode (or already-selected tile) → toggle membership in
    // the selected set. Otherwise open the per-photo quick-edit popup.
    if (isPhotoSelectMode() || (window._photoSelected && window._photoSelected.has(photoId))) {
      ev.preventDefault();
      togglePhotoSelection(photoId);
      return;
    }
    var idx = (window._allPhotos || []).indexOf(photo);
    if (idx >= 0 && typeof showPhotoActions === 'function') showPhotoActions(idx, ev);
  });
}

function renderPhotoGrid() {
  var photos = window._allPhotos || [];
  var filter = window._photoFilter || 'all';

  var filtered = photos;
  if (filter === 'Before' || filter === 'During' || filter === 'After') {
    filtered = photos.filter(function(p){ return p.phase === filter; });
  } else if (filter === 'annotated') {
    filtered = photos.filter(function(p){ return p.isAnnotated; });
  }

  if (filtered.length === 0) {
    document.getElementById('photosByPhase').innerHTML = '<div class="empty"><div class="empty-icon">&#128248;</div>' + (photos.length ? 'No photos match this filter' : 'No photos yet') + '</div>';
    ensurePhotoGridDelegate();
    return;
  }

  var phases = { 'Before': [], 'During': [], 'After': [] };
  filtered.forEach(function(p) {
    var ph = phases[p.phase] ? p.phase : 'During';
    phases[ph].push(p);
  });

  var phaseColors = { 'Before': '#3b82f6', 'During': 'var(--orange)', 'After': 'var(--green)' };
  var esc = nbdEscFn();
  var html = '';

  ['Before', 'During', 'After'].forEach(function(phase) {
    var fullList = phases[phase];
    if (fullList.length === 0) return;
    var color = phaseColors[phase];
    var expanded = !!window._phaseExpanded[phase];
    var visible = (expanded || fullList.length <= PHOTO_PHASE_CAP) ? fullList : fullList.slice(0, PHOTO_PHASE_CAP);
    var hidden = fullList.length - visible.length;

    html += '<div class="photo-phase ct-mb20">';
    html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;padding-bottom:6px;border-bottom:2px solid ' + color + ';">';
    html += '<div style="width:10px;height:10px;border-radius:50%;background:' + color + ';"></div>';
    html += '<div class="photo-phase-title ct-phase-title">' + esc(phase) + ' Phase</div>';
    html += '<span class="ct-muted">(' + fullList.length + (hidden ? ' • showing ' + visible.length : '') + ')</span>';
    html += '</div>';
    html += '<div class="photo-grid-phase ct-photo-grid">';
    for (var i = 0; i < visible.length; i++) {
      html += buildPhotoTile(visible[i], esc);
    }
    html += '</div>';
    if (fullList.length > PHOTO_PHASE_CAP) {
      var label = expanded ? 'Show first ' + PHOTO_PHASE_CAP : 'Show all ' + fullList.length;
      html += '<button type="button" class="nbd-show-all-btn" data-phase="' + esc(phase) + '" style="margin-top:8px;width:100%;padding:8px;background:transparent;color:' + color + ';border:1px solid ' + color + ';border-radius:6px;cursor:pointer;font-weight:600;font-size:12px;">' + label + ' (' + fullList.length + ' total)</button>';
    }
    html += '</div>';
  });

  var pbpEl = document.getElementById('photosByPhase');
  pbpEl.innerHTML = html;
  ensurePhotoGridDelegate();
}

// Map a Firestore photo doc into the in-memory shape the render
// code expects. Pulled out so the IDB cache + the live Firestore
// path use the exact same projection — otherwise a cache hit and
// a fresh fetch would produce subtly different objects and
// trigger re-renders that look like flicker.
function photoDocToView(id, d) {
  return {
    id: id,
    url: d.url,
    // urls + storagePath are written by uploadSinglePhoto + the
    // image-pipeline trigger (PR #75). Carry them through so the
    // <img srcset> render path can prefer the cached variants.
    urls: d.urls || null,
    storagePath: d.storagePath || '',
    phase: d.phase || 'During',
    category: d.category || 'Property',
    description: d.description || d.notes || '',
    filename: d.filename || '',
    // Normalized on read: legacy docs carry any of the four historical
    // spellings, and every consumer below (badge, quick-edit select,
    // photo-report pairing) assumes the canonical id.
    damageType: _dmgNorm(d.damageType),
    severity: d.severity || '',
    location: d.location || '',
    tags: d.tags || [],
    isAnnotated: d.isAnnotated || false,
    sharedWithHomeowner: !!d.sharedWithHomeowner,
    homeownerCaption: d.homeownerCaption || '',
    date: d.date,
    uploadedAt: d.uploadedAt
  };
}

// Apply a list of photos to local state + paint. Idempotent —
// safe to call once with cached data, then again with fresh data.
function applyPhotosToView(list) {
  window._allPhotos = list || [];
  window._photoById = new Map();
  for (var i = 0; i < window._allPhotos.length; i++) {
    var p = window._allPhotos[i];
    if (p && p.id) window._photoById.set(p.id, p);
  }
  if (!window._allPhotos.length) {
    document.getElementById('photosByPhase').innerHTML =
      '<div class="empty"><div class="empty-icon">&#128248;</div>No photos yet</div>';
  }
  updatePhotoStats();
  renderPhotoGrid();
}

// Load photos for a lead. Uses NBDIDBCache.revalidate so the page
// paints from IndexedDB in <50 ms (covering the photos that were
// on screen last time), then refreshes from Firestore in parallel.
// On Firestore failure (offline / network blip), the cached data
// stays on screen so Joe can still review the lead in a driveway.
async function loadPhotosByPhase(leadId) {
  const uid = window.auth && window.auth.currentUser && window.auth.currentUser.uid;
  if (!uid) return;

  const fetchFresh = async function () {
    // Shared fetch (2026-09-17, customer-bootstrap.module.js) — was its own
    // getDocs() here (team visibility matches loadPhotos()'s #photoList
    // query via window._photoQueryScopes, "the third hand-rolled copy; now
    // there are none" per that fix's own comment). Now routes through the
    // same in-flight-deduped fetch loadPhotos() uses, so the two loaders
    // share one Firestore read when loadAllCustomerPhotos() fires both —
    // this function's own IndexedDB caching below is unchanged.
    // Registry-only (Globals Tranche 3 T3-C, 2026-09-18), not window.
    const raw = await window.__NBD_CALL_REGISTRY._fetchPhotosRaw(leadId);
    return raw.map(function (d) { return photoDocToView(d.id, d); });
  };

  // Cache layer is opt-in — if NBDIDBCache failed to load (CSP
  // block, cache miss, very old browser) fall through to a plain
  // Firestore fetch with the same view code.
  if (!window.NBDIDBCache) {
    try {
      const list = await fetchFresh();
      applyPhotosToView(list);
    } catch (error) {
      console.error('Photos load error:', error);
      document.getElementById('photosByPhase').innerHTML =
        '<div class="empty"><div class="empty-icon">&#9888;</div>Failed to load photos</div>';
    }
    return;
  }

  try {
    const fresh = await window.NBDIDBCache.revalidate(
      'photos:' + uid + ':' + leadId,
      fetchFresh,
      {
        // Don't trust cached photos older than 30 days — sanity
        // bound so a long-dormant lead doesn't reopen with
        // year-stale data on screen.
        maxAgeMs: 30 * 86400000,
        onCached: function (cached) { applyPhotosToView(cached); }
      }
    );
    applyPhotosToView(fresh);
  } catch (error) {
    console.error('Photos load error:', error);
    if (!(window._allPhotos && window._allPhotos.length)) {
      document.getElementById('photosByPhase').innerHTML =
        '<div class="empty"><div class="empty-icon">&#9888;</div>Failed to load photos</div>';
    }
  }
}

function updatePhotoStats() {
  var bar = document.getElementById('photoStatsBar');
  if (!bar) return;
  var photos = window._allPhotos || [];
  // Count badges ride the same load: nav chip + both photo panel titles.
  window.nbdNavCount('navCountPhotos', photos.length);
  window.nbdTitleCount('projectPhotosTitle', 'Project Photos', photos.length);
  window.nbdTitleCount('photosPanelTitle', 'Photos', photos.length);
  if (photos.length === 0) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  
  var before = photos.filter(function(p){return p.phase==='Before';}).length;
  var during = photos.filter(function(p){return p.phase==='During';}).length;
  var after = photos.filter(function(p){return p.phase==='After';}).length;
  var annotated = photos.filter(function(p){return p.isAnnotated;}).length;
  
  var html = '<span class="ct-strong">' + photos.length + ' Photos</span>';
  if (before) html += '<span class="ct-c-blue">&#9679; ' + before + ' Before</span>';
  if (during) html += '<span class="ct-c-orange">&#9679; ' + during + ' During</span>';
  if (after) html += '<span class="ct-c-green">&#9679; ' + after + ' After</span>';
  if (annotated) html += '<span class="ct-c-purple">&#9679; ' + annotated + ' Annotated</span>';
  bar.innerHTML = html;
}

// ── Reports ────────────────────────────────────
window.loadReports = async function(leadId) {
  try {
    const reportsRef = window.collection(window.db, 'reports');
    // The reports read rule is owner-scoped (userId == auth.uid). A
    // leadId-only query can't prove ownership to the rules engine, so this
    // ALWAYS failed permission-denied ("Failed to load reports" on every
    // customer page). Two equality filters need no composite index; sort
    // client-side instead of orderBy (which would).
    const uid = window.auth?.currentUser?.uid || null;
    const q = window.query(reportsRef, window.where('leadId', '==', leadId), window.where('userId', '==', uid));
    const snap = await window.getDocs(q);

    if (snap.empty) {
      document.getElementById('reportList').innerHTML = '<div class="empty"><div class="empty-icon">📋</div>No reports yet</div>';
      return;
    }

    const esc = window.nbdEsc || (s => String(s == null ? '' : s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])));
    let html = '';
    const reportDocs = [];
    const sortedDocs = snap.docs.slice().sort((a, b) => {
      const ad = a.data().date, bd = b.data().date;
      const at = ad?.toDate ? ad.toDate().getTime() : new Date(ad || 0).getTime();
      const bt = bd?.toDate ? bd.toDate().getTime() : new Date(bd || 0).getTime();
      return bt - at;
    });
    sortedDocs.forEach(doc => {
      const report = doc.data();
      reportDocs.push(report);
      const idx = reportDocs.length - 1;
      const date = report.date?.toDate ? report.date.toDate() : new Date(report.date);
      const icon = report.type === 'inspection' ? '📋' : report.type === 'damage' ? '⚠️' : '✓';

      html += `
        <div class="doc-item">
          <div class="doc-icon">${icon}</div>
          <div class="doc-content">
            <div class="doc-type">${esc(report.type || 'Report')}</div>
            <div class="doc-name">${esc(report.title || report.type || 'Report')}</div>
            <div class="doc-date">${esc(date.toLocaleDateString())}</div>
          </div>
          <div class="doc-actions">
            <button class="doc-btn nbd-report-view" data-report-idx="${idx}">View</button>
          </div>
        </div>
      `;
    });

    const reportListEl = document.getElementById('reportList');
    reportListEl.innerHTML = html;
    reportListEl.querySelectorAll('.nbd-report-view').forEach(btn => {
      btn.addEventListener('click', () => {
        const r = reportDocs[Number(btn.dataset.reportIdx)];
        // Saved reports store their HTML INLINE on the doc (saveReport writes
        // `html`), not a hosted `htmlUrl` — so this button used to silently
        // no-op. Open a hosted URL if one is ever present, else open the inline
        // HTML in a same-origin blob tab.
        const hostedUrl = r && r.htmlUrl;
        if (/^https?:/i.test(String(hostedUrl || ''))) {
          window.open(hostedUrl, '_blank', 'noopener,noreferrer');
          return;
        }
        const html = r && r.html;
        if (html && typeof html === 'string') {
          const blobUrl = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
          window.open(blobUrl, '_blank', 'noopener,noreferrer');
          setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
        } else if (typeof showToast === 'function') {
          showToast('This report has no viewable content', 'error');
        }
      });
    });
  } catch (error) {
    console.error('Reports load error:', error);
    document.getElementById('reportList').innerHTML = '<div class="empty"><div class="empty-icon">⚠️</div>Failed to load reports</div>';
  }
};

// ── Shared Documents — REMOVED (2026-08-18) ───────────────────
// window.loadSharedDocuments read the top-level `lead_documents`
// collection. Nothing in this app has ever written that collection —
// not the client, not functions/ — so the "Shared Documents" panel it
// fed could only ever render its empty state. The panel is gone from
// customer.html and the documents surfaces are now fed from the one
// real store by customer-documents.js.

// ── Communication Log ──────────────────────────
// Team thread: company_admin / manager / viewer with a companyId claim
// query by leadId+companyId (all tenant sends). Sales reps (and anyone
// without a companyId) still query leadId+uid (own sends only) — matches
// firestore.rules. New platform sends stamp companyId for the team path.
async function loadCommunicationLog(leadId) {
  try {
    const uid = window.auth?.currentUser?.uid || window._user?.uid;
    if (!uid || !window.db) {
      document.getElementById('communicationLog').innerHTML = '<div class="empty"><div class="empty-icon">💬</div>Sign in to view messages</div>';
      return;
    }
    const claims = window._userClaims || {};
    const role = claims.role || '';
    const companyId = claims.companyId || null;
    const teamThread = !!(companyId && (role === 'company_admin' || role === 'manager' || role === 'viewer' || claims.owner === true));

    const emailRef = window.collection(window.db, 'email_log');
    const smsRef = window.collection(window.db, 'sms_log');

    let emailQ, smsQ;
    if (teamThread) {
      emailQ = window.query(emailRef,
        window.where('leadId', '==', leadId),
        window.where('companyId', '==', companyId),
        window.orderBy('date', 'desc'), window.limit(30));
      smsQ = window.query(smsRef,
        window.where('leadId', '==', leadId),
        window.where('companyId', '==', companyId),
        window.orderBy('date', 'desc'), window.limit(30));
    } else {
      emailQ = window.query(emailRef,
        window.where('leadId', '==', leadId),
        window.where('uid', '==', uid),
        window.orderBy('date', 'desc'), window.limit(20));
      smsQ = window.query(smsRef,
        window.where('leadId', '==', leadId),
        window.where('uid', '==', uid),
        window.orderBy('date', 'desc'), window.limit(20));
    }

    const emailSnap = await window.getDocs(emailQ);
    const smsSnap = await window.getDocs(smsQ);

    let comms = [];

    emailSnap.forEach(doc => {
      const data = doc.data();
      comms.push({
        type: 'email',
        date: data.date?.toDate ? data.date.toDate() : new Date(data.date),
        subject: data.subject || 'Email',
        preview: data.body?.substring(0, 100) || '',
        status: data.status || 'sent',
        fromUid: data.uid || null,
      });
    });

    smsSnap.forEach(doc => {
      const data = doc.data();
      // The producer (logSMSToFirestore) stores the text in `body`; tolerate a
      // legacy `message` field too. Was reading only `message` — always blank.
      const smsText = data.body || data.message || '';
      comms.push({
        type: 'sms',
        id: doc.id,
        date: data.date?.toDate ? data.date.toDate() : new Date(data.date),
        subject: smsText || 'Text Message',
        preview: smsText.substring(0, 100),
        status: data.status || 'sent',
        fromUid: data.uid || null,
        // An outbound text: a STOP reply to it may have landed on the
        // sender's own phone (review R2-3-1) — offer "They replied STOP".
        outbound: (data.status || 'sent') !== 'received',
      });
    });

    // Sort by date descending
    comms.sort((a, b) => b.date - a.date);
    comms = comms.slice(0, 30);

    if (comms.length === 0) {
      const hint = teamThread
        ? 'No platform messages yet for this lead (team view).'
        : 'No messages yet — platform email/SMS will appear here.';
      document.getElementById('communicationLog').innerHTML = '<div class="empty"><div class="empty-icon">💬</div>' + hint + '</div>';
      return;
    }

    // Every field below is user-controlled (email subject/body, SMS body from
    // incoming webhook or outbound send). Escape everything before innerHTML.
    const esc = window.nbdEsc || (s => String(s == null ? '' : s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])));
    let html = '';
    if (teamThread) {
      html += '<div class="ct-hint">Team thread · all company sends for this lead</div>';
    }
    comms.forEach(comm => {
      const dateStr = comm.date.toLocaleDateString() + ' ' + comm.date.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
      const safeType = comm.type === 'sms' ? 'sms' : 'email';
      const who = (teamThread && comm.fromUid && comm.fromUid !== uid)
        ? '<span class="ct-hint-inline">· teammate</span>'
        : '';
      html += `
        <div class="comm-item">
          <div class="comm-header">
            <div class="comm-type ${safeType}">${safeType.toUpperCase()}</div>
            <div class="comm-status">${esc(comm.status)}</div>
            <div class="comm-date">${esc(dateStr)}</div>${who}
          </div>
          <div class="comm-subject">${esc(comm.subject)}</div>
          ${comm.preview ? `<div class="comm-preview">${esc(comm.preview)}${comm.preview.length > 100 ? '...' : ''}</div>` : ''}
          ${comm.type === 'sms' && comm.outbound && comm.id ? `<button type="button" class="btn btn-ghost btn-sm comm-stop" data-comm-stop="${esc(comm.id)}" data-comm-lead="${esc(leadId)}">They replied STOP</button>` : ''}
        </div>
      `;
    });

    document.getElementById('communicationLog').innerHTML = html;
    window.nbdTitleCount('commsPanelTitle', 'Recent Communications', comms.length);
  } catch (error) {
    console.error('Communication log error:', error);
    document.getElementById('communicationLog').innerHTML = '<div class="empty"><div class="empty-icon">⚠️</div>Failed to load messages</div>';
  }
}

// "They replied STOP" on an outbound text in the Communication Log (review
// R2-3-1, Jo 2026-10-06). A homeowner's STOP to a text sent from the owner's
// own phone lands on that phone, where the CRM never sees it. One tap records
// it exactly like an inbound STOP (the STOP register + Do Not Text lists),
// server-side: phoneTextAction 'stop' via phone-share.js (loaded on this page).
document.addEventListener('click', async function (ev) {
  const btn = ev.target && ev.target.closest ? ev.target.closest('[data-comm-stop]') : null;
  if (!btn) return;
  ev.preventDefault();
  if (window.NBDRole && typeof window.NBDRole.guard === 'function' && !window.NBDRole.guard()) return;
  const PS = window.NBDPhoneShare;
  if (!PS || typeof PS.reportStop !== 'function') { if (window.showToast) window.showToast('Still loading — try again in a moment', 'error'); return; }
  const ask = window.nbdConfirm || function (m) { return Promise.resolve(window.confirm(m)); };
  if (!(await ask('Record that this customer replied STOP? Nobody at your company will be able to text this number again (they can text START to resume).'))) return;
  btn.disabled = true;
  const r = await PS.reportStop({ leadId: btn.getAttribute('data-comm-lead'), logId: btn.getAttribute('data-comm-stop') });
  if (r && r.ok) {
    btn.textContent = 'STOP recorded';
    if (window.showToast) window.showToast('Recorded — this customer won’t be texted again', 'success');
  } else {
    btn.disabled = false;
    if (window.showToast) window.showToast('Could not record it: ' + ((r && r.reason) || 'error'), 'error');
  }
});

// ── Photo Quick Actions (Edit Tags, Delete, Phase) ──────
window._quickEditPhotoId = null;

window.openPhotoInEditor = function(idx) {
  var photo = (window._allPhotos || [])[idx];
  if (!photo) return;
  if (window.NBDPhotoEditor) {
    window.NBDPhotoEditor.open(photo.url, photo.id, window._customerId, photo);
  } else {
    // Pass the array we indexed into (_allPhotos) plus the index, so the
    // lightbox arrows walk THIS list and not whichever one loaded last.
    openPhotoLightbox(photo.url, photo.description || '', window._allPhotos || [], Number(idx) || 0);
  }
};

window.showPhotoActions = function(idx, event) {
  if (event) { event.preventDefault(); event.stopPropagation(); }
  var photo = (window._allPhotos || [])[idx];
  if (!photo) return;
  window._quickEditPhotoId = photo.id;
  window._quickEditPhotoIdx = idx;
  
  // Remove existing popup
  var existing = document.getElementById('photoActionPopup');
  if (existing) existing.remove();
  
  var popup = document.createElement('div');
  popup.id = 'photoActionPopup';
  // --z-overlay, not 9000 (2026-09-25, phone audit). 9000 put this sheet
  // UNDER the field-tool FABs (9999) and the quick-action bar, so on a phone
  // the FABs sat on the right end of "Set as Cover Photo" and "Delete" and a
  // tap on Delete's right edge opened Quick Capture instead. It is a modal
  // backdrop like every other overlay on this page, so it takes that tier.
  popup.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.5);z-index:var(--z-overlay,10000);display:flex;align-items:center;justify-content:center;';
  popup.onclick = function(e) { if (e.target === popup) popup.remove(); };
  
  var phaseColors = { 'Before': '#3b82f6', 'During': 'var(--orange)', 'After': 'var(--green)' };
  var sevColors = { 'minor': 'var(--gold)', 'moderate': 'var(--orange)', 'severe': 'var(--red)' };
  
  var card = document.createElement('div');
  card.style.cssText = 'background:var(--bg,#0f172a);border:1px solid var(--br,#2a2a4e);border-radius:16px;padding:24px;max-width:420px;width:90%;color:var(--t);font-family:system-ui,sans-serif;';
  
  card.innerHTML = '<div class="ct-head">' +
    '<div class="ct-row10">' +
    '<img src="' + photo.url + '" loading="lazy" decoding="async" class="ct-thumb">' +
    '<div class="ct-title">Edit Photo</div></div>' +
    // The × was a bare 13x26 glyph; 40x40 is a thumb-sized target (2026-09-25).
    '<button data-action="_closePhotoActionPopup" aria-label="Close" class="ct-close">&times;</button></div>' +
    
    '<div class="ct-mb14">' +
    '<label class="ct-label-sm">Phase</label>' +
    '<div class="ct-row4" id="qePhaseButtons">' +
    ['Before','During','After'].map(function(p) {
      var active = photo.phase === p;
      var c = phaseColors[p];
      return '<button data-action="quickSetPhase" data-arg="' + p + '" data-pass-el="true" style="flex:1;padding:8px;font-size:13px;font-weight:600;border-radius:6px;cursor:pointer;border:1px solid ' + c + ';' +
        (active ? 'background:' + c + ';color:#fff;' : 'background:transparent;color:' + c + ';') + '">' + p + '</button>';
    }).join('') +
    '</div></div>' +
    
    '<div class="ct-mb14">' +
    '<label class="ct-label-sm">Damage Type</label>' +
    '<select id="qeDamageType" data-change-action="quickSaveMeta" class="ct-field-sm">' +
    '<option value="">None</option>' +
    _dmgOptions().map(function(o) {
      return '<option value="' + o[0] + '"' + (_dmgNorm(photo.damageType) === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
    }).join('') +
    '</select></div>' +
    
    '<div class="ct-mb14">' +
    '<label class="ct-label-sm">Severity</label>' +
    '<div class="ct-row4" id="qeSeverityButtons">' +
    ['minor','moderate','severe'].map(function(s) {
      var active = photo.severity === s;
      var c = sevColors[s];
      return '<button data-action="quickSetSeverity" data-arg="' + s + '" data-pass-el="true" style="flex:1;padding:7px;font-size:12px;font-weight:600;border-radius:6px;cursor:pointer;border:1px solid ' + c + ';text-transform:capitalize;' +
        (active ? 'background:' + c + ';color:#fff;' : 'background:transparent;color:' + c + ';') + '">' + s + '</button>';
    }).join('') +
    '</div></div>' +
    
    '<div class="ct-mb14">' +
    '<label class="ct-label-sm">Location</label>' +
    '<select id="qeLocation" data-change-action="quickSaveMeta" class="ct-field-sm">' +
    '<option value="">None</option>' +
    ['Ridge','Hip','Valley','Field','Edge','Flashing','Vent','Chimney','Skylight','Gutter','Soffit','Fascia'].map(function(l) {
      return '<option value="' + l + '"' + (photo.location === l ? ' selected' : '') + '>' + l + '</option>';
    }).join('') +
    '</select></div>' +
    
    '<div class="ct-mb20">' +
    '<label class="ct-label-sm">Description</label>' +
    '<input type="text" id="qeDescription" value="' + (photo.description || '').replace(/"/g, '&quot;') + '" placeholder="Add description..." aria-label="Photo description" data-change-action="quickSaveMeta" class="ct-field-sm ct-bb">' +
    '</div>' +
    
    // RoofLink "Set Cover": toggles lead.coverPhotoId/-Url. Label reflects
    // whether THIS photo is already the cover.
    '<button data-action="setCoverPhotoFromPopup" data-arg="' + idx + '" style="width:100%;margin-bottom:8px;padding:10px;background:' +
      ((window._currentLead && window._currentLead.coverPhotoId === photo.id)
        ? 'rgba(245,158,11,.2);color:var(--gold,#eab308);border:1px solid var(--gold,#eab308);'
        : 'rgba(255,255,255,.08);color:var(--t);border:1px solid var(--br,#334155);') +
      'border-radius:8px;cursor:pointer;font-weight:600;font-size:13px;">' +
      ((window._currentLead && window._currentLead.coverPhotoId === photo.id) ? '★ Cover Photo — tap to clear' : '☆ Set as Cover Photo') +
    '</button>' +
    '<div class="ct-row8">' +
    '<button data-action="_previewPhotoFromPopup" data-arg="' + idx + '" class="ct-btn ct-btn-ghost">👁 Preview</button>' +
    '<button data-action="_openPhotoInEditorAndClose" data-arg="' + idx + '" class="ct-btn ct-btn-primary">Open Editor</button>' +
    '<button data-action="deletePhoto" data-arg="' + photo.id + '" class="ct-btn ct-btn-danger">Delete</button>' +
    '</div>';
  
  popup.appendChild(card);
  document.body.appendChild(popup);
};

window.quickSetPhase = function(phase, btn) {
  var photo = (window._allPhotos || [])[window._quickEditPhotoIdx];
  if (!photo) return;
  // Remember what it was and that the rep actually chose — quickSaveMeta
  // only writes the phase key when this ran. See the note there.
  if (photo._phaseTouched !== true) photo._phaseWas = photo.phase;
  photo._phaseTouched = true;
  photo.phase = phase;
  
  var phaseColors = { 'Before': '#3b82f6', 'During': 'var(--orange)', 'After': 'var(--green)' };
  document.querySelectorAll('#qePhaseButtons button').forEach(function(b) {
    b.style.background = 'transparent';
    b.style.color = b.style.borderColor;
  });
  btn.style.background = phaseColors[phase] || 'var(--orange)';
  btn.style.color = '#fff';
  
  quickSaveMeta();
};

window.quickSetSeverity = function(sev, btn) {
  var photo = (window._allPhotos || [])[window._quickEditPhotoIdx];
  if (!photo) return;
  
  if (photo.severity === sev) {
    photo.severity = '';
    btn.style.background = 'transparent';
    btn.style.color = btn.style.borderColor;
  } else {
    photo.severity = sev;
    var sevColors = { 'minor': 'var(--gold)', 'moderate': 'var(--orange)', 'severe': 'var(--red)' };
    document.querySelectorAll('#qeSeverityButtons button').forEach(function(b) {
      b.style.background = 'transparent';
      b.style.color = b.style.borderColor;
    });
    btn.style.background = sevColors[sev] || 'var(--orange)';
    btn.style.color = '#fff';
  }
  
  quickSaveMeta();
};

window.quickSaveMeta = async function() {
  var photo = (window._allPhotos || [])[window._quickEditPhotoIdx];
  if (!photo || !photo.id) return;

  try {
    // Only write `phase` when the rep actually picked one in this popup.
    //
    // photoDocToView coerces `d.phase || 'During'`, so photo.phase is NEVER
    // falsy here — an unconditional `phase: photo.phase || 'During'` stamped
    // a concrete phase into Firestore on EVERY metadata edit, including ones
    // where the rep only typed a description or a location. A photo that
    // uploaded unsorted and showed correctly in Review & Sort was silently
    // re-marked "reviewed" the first time anyone touched any other field,
    // which also re-masked the AI's phase suggestion. Omitting the key
    // leaves absence intact and avoids clobbering a phase another surface
    // (photo-review, bulk assign) may have set since this view was built.
    var phaseTouched = photo._phaseTouched === true;
    var prevPhase = phaseTouched ? photo._phaseWas : photo.phase;
    var updates = {
      damageType: _dmgNorm(document.getElementById('qeDamageType')?.value),
      severity: photo.severity || '',
      location: document.getElementById('qeLocation')?.value || '',
      description: document.getElementById('qeDescription')?.value || ''
    };
    if (phaseTouched) updates.phase = photo.phase;

    // Update local data
    Object.assign(photo, updates);

    // Save to Firestore
    await window.updateDoc(window.doc(window.db, 'photos', photo.id), updates);

    // Surgical update: if phase didn't change, just patch the badges on
    // this one tile (O(1)). If phase changed, the tile lives in a
    // different section so a full re-render is needed (rare path).
    updatePhotoStats();
    photo._phaseTouched = false;
    if (!phaseTouched || updates.phase === prevPhase) {
      updatePhotoTile(photo.id);
    } else {
      renderPhotoGrid();
    }

    if (window.showToast) window.showToast('Photo updated', 'success');
  } catch (error) {
    console.error('Error saving photo metadata:', error);
    if (window.showToast) window.showToast('Failed to save: ' + error.message, 'error');
  }
};

window.deletePhoto = async function(photoId) {
  // native confirm() is patched to silently return true in PWA mode
  // (standalone-compat.js), so route through nbdConfirm to get a real Cancel.
  const ask = window.nbdConfirm || ((m) => Promise.resolve(window.confirm(m)));
  if (!(await ask('Delete this photo? This cannot be undone.'))) return;

  try {
    await window.deleteDoc(window.doc(window.db, 'photos', photoId));

    // Remove from local array + id Map
    window._allPhotos = (window._allPhotos || []).filter(function(p) { return p.id !== photoId; });
    if (window._photoById) window._photoById.delete(photoId);

    // Close popup
    var popup = document.getElementById('photoActionPopup');
    if (popup) popup.remove();

    // Counts always need recompute. The phase header counts depend on
    // the deleted photo's old phase, so we let renderPhotoGrid() rebuild
    // — this is a rare event compared to metadata edits.
    updatePhotoStats();
    renderPhotoGrid();

    // Also refresh overview photos. Registry-only, not a bare reference —
    // see the bulk-delete handler's comment above for why.
    try { await window.__NBD_CALL_REGISTRY.loadPhotos(window._customerId); } catch(e) {}

    if (window.showToast) window.showToast('Photo deleted', 'success');
  } catch (error) {
    console.error('Error deleting photo:', error);
    if (window.showToast) window.showToast('Failed to delete: ' + error.message, 'error');
  }
};

// ── Document Generator Integration ─────────────
// ══════════════════════════════════════════════════════════════════
// DOCUMENT GENERATOR — DATA BRIDGE + PREREQUISITE GATES
// Pulls real customer data from Firestore, checks prerequisites
// before generating. No more hardcoded defaults or DOM scraping.
// ══════════════════════════════════════════════════════════════════

const DOC_PREREQUISITES = {
  proposal:             { needs: ['estimate'], label: 'Proposal / Estimate', msg: 'Build an estimate first in the Estimates tab.' },
  contract:             { needs: ['estimate','contact'], label: 'Roofing Contract', msg: 'Build an estimate and add customer contact info.' },
  work_authorization:   { needs: ['address','scope'], label: 'Work Authorization', msg: 'Add property address and scope of work.' },
  scope_of_work:        { needs: ['estimate'], label: 'Scope of Work', msg: 'Build an estimate to generate scope details.' },
  inspectionHomeowner:  { needs: ['photos'], label: 'Inspection Report', msg: 'Upload inspection photos first.' },
  inspectionInsurance:  { needs: ['photos','claim'], label: 'Insurance Report', msg: 'Upload photos and add insurance claim info (carrier + claim #).' },
  supplement_request:   { needs: ['estimate','claim'], label: 'Supplement Request', msg: 'Requires an estimate and filed insurance claim.' },
  warranty_certificate: { needs: ['jobComplete'], label: 'Warranty Certificate', msg: 'Job must be marked Complete to generate warranty.' },
  certificate_of_completion: { needs: ['jobComplete','beforeAfterPhotos'], label: 'Certificate of Completion', msg: 'Job must be complete with before & after photos.' },
  invoice:              { needs: ['jobValue'], label: 'Invoice', msg: 'Add a job value or build an estimate first.' },
  change_order:         { needs: ['estimate'], label: 'Change Order', msg: 'Requires an existing estimate to modify.' },
  before_after_report:  { needs: ['beforeAfterPhotos'], label: 'Before & After Report', msg: 'Need BOTH before and after photos uploaded.' },
  financing_options:    { needs: ['jobValue'], label: 'Financing Options', msg: 'Add a job value or build an estimate.' },
  company_intro:        { needs: [], label: 'Company Introduction' },
  referral_card:        { needs: [], label: 'Referral Card' },
  storm_checklist:      { needs: [], label: 'Storm Checklist' },
  claim_guide:          { needs: [], label: 'Claim Guide' },
  door_hanger:          { needs: [], label: 'Door Hanger' },
  neighborhood_mailer:  { needs: [], label: 'Neighborhood Mailer' },
  testimonial_sheet:    { needs: [], label: 'Testimonial Sheet' },
  thank_you:            { needs: [], label: 'Thank You' },
  payment_agreement:    { needs: ['jobValue','contact'], label: 'Payment Agreement', msg: 'Add job value and customer contact info.' },
  storm_history_report: { needs: ['address'], label: 'Storm History Report', msg: 'Add a property address first — it\'s used to pull the NOAA storm history.' },
  // Template library (2026-10-04) — document-generator-library.js.
  lien_waiver:          { needs: ['address'], label: 'Lien Waiver', msg: 'Add the property address first.' },
  right_to_cancel:      { needs: ['address'], label: 'Right to Cancel', msg: 'Add the property address first.' },
  material_selection:   { needs: ['address'], label: 'Material & Color Selection', msg: 'Add the property address first.' },
  proposal_options:     { needs: ['estimate'], label: 'Good-Better-Best Options', msg: 'Build an estimate first — its package prices fill the page.' },
  insurance_next_steps: { needs: ['address'], label: 'Insurance Next Steps', msg: 'Add the property address first.' }
};

function getCustomerDocData() {
  const lead = window._leadDoc || {};
  const id = window._customerId;
  const estimates = window._customerEstimates || [];
  const photos = window._allPhotos || [];
  const est = estimates.length > 0 ? estimates[0] : null;
  // Job Template estimates (2026-09-25) carry a job-type warranty and no
  // tier; null for every other estimate, which keeps its tier wording.
  const _jw = (window.NBDCustomerEstimateRows?.estimateWarranty?.(est)) || null;
  const beforePhotos = photos.filter(p => (p.phase||'').toLowerCase() === 'before');
  const afterPhotos = photos.filter(p => (p.phase||'').toLowerCase() === 'after');
  const duringPhotos = photos.filter(p => (p.phase||'').toLowerCase() === 'during');
  const name = ((lead.firstName||'') + ' ' + (lead.lastName||'')).trim();
  // The estimate's total wins over lead.jobValue, which can lag a re-saved
  // estimate (review R2-2-4 / R4); lead.jobValue only when it has no price.
  const _rows = window.NBDCustomerEstimateRows;
  const _estVal = !est ? 0 : (_rows && typeof _rows.estimateValue === 'function')
    ? _rows.estimateValue(est)
    : (Number(est.grandTotal || est.total || est.amount) || 0);
  const jobVal = _estVal > 0 ? _estVal : (lead.jobValue || 0);

  return {
    // Customer info
    homeownerName: name, customerName: name,
    firstName: lead.firstName || '', lastName: lead.lastName || '',
    address: lead.address || '', homeownerAddress: lead.address || '',
    phone: lead.phone || '', customerPhone: lead.phone || '',
    email: lead.email || '', customerEmail: lead.email || '',
    // Already-geocoded pin (set on save / from the map), if any — lets the
    // Storm History Report doc skip a fresh Nominatim lookup.
    lat: (lead.lat != null ? lead.lat : null), lng: (lead.lng != null ? lead.lng : null),

    // Job info — subType + trades added so docs that vary by sub-type
    // (e.g. fire AOB vs storm AOB) and by trade scope (roof+gutters
    // combo line items) can reach those fields.
    damageType: lead.damageType || '', stage: lead.stage || '',
    source: lead.source || '', notes: lead.notes || '',
    jobType: lead.jobType || '', jobValue: jobVal,
    subType: lead.subType || '',
    trades:  Array.isArray(lead.trades) ? lead.trades : [],
    tradesLabel: Array.isArray(lead.trades) && lead.trades.length
                   ? (typeof window.tradesLabel === 'function' ? window.tradesLabel(lead.trades) : lead.trades.join(', '))
                   : '',
    scopeOfWork: lead.scopeOfWork || '',
    projectDescription: lead.scopeOfWork || est?.description || '',

    // Insurance
    insCarrier: lead.insCarrier || '', insuranceCompany: lead.insCarrier || '',
    claimNumber: lead.claimNumber || '', claimStatus: lead.claimStatus || '',
    policyNumber: lead.policyNumber || '', dateOfLoss: lead.dateOfLoss || '',
    deductible: lead.deductibleOrOwedByHO || lead.deductible || '', supplementStatus: lead.supplementStatus || '',

    // Estimate
    totalPrice: jobVal ? '$' + Number(jobVal).toLocaleString() : '',
    estimateAmount: jobVal ? '$' + Number(jobVal).toLocaleString() : '',
    contractPrice: jobVal ? '$' + Number(jobVal).toLocaleString() : '',
    warrantyTier: _jw ? _jw.wordingTier : (est?.tier || est?.tierName || lead.warrantyTier || ''),
    workmanshipWarranty: (_jw && _jw.text !== null) ? _jw.text : null,
    workmanshipWarrantyYears: _jw ? _jw.years : null,
    // Was `est?.lineItems || []`, which is ALWAYS empty for a V2 estimate —
    // V2 writes `rows`. The empty array reached resolveDocManufacturer, which
    // finds no shingle line and falls back to its hardcoded default, so
    // warranty certificates and proposals claimed GAF Timberline on TAMKO
    // jobs. buildDocLineItems reads both shapes at the RETAIL ladder.
    estimateLineItems: (window.NBDCustomerEstimateRows?.buildDocLineItems?.(est)) || est?.lineItems || [],
    // Every package price the estimate saved + the one it was quoted at
    // (Good-Better-Best options page, 2026-10-04).
    tierPrices: (est && est.prices && typeof est.prices === 'object') ? est.prices : null,
    selectedTier: est ? (est.selectedTier || est.tier || '') : '',

    // Property
    roofAge: lead.roofAge || '', roofType: lead.roofType || '',
    stories: lead.stories || '', pitch: lead.pitch || '',
    squareFootage: lead.squareFootage || '',

    // Photos
    beforePhotoUrl: beforePhotos[0]?.url || '',
    afterPhotoUrl: afterPhotos[0]?.url || '',
    beforePhotos: beforePhotos, afterPhotos: afterPhotos, duringPhotos: duringPhotos,
    photoCount: photos.length, allPhotos: photos,

    // Meta
    date: new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' }),
    leadId: id,

    // Computed flags (for prerequisite checks)
    _hasEstimate: estimates.length > 0,
    _hasPhotos: photos.length > 0,
    _hasBeforeAfterPhotos: beforePhotos.length > 0 && afterPhotos.length > 0,
    _hasClaim: !!(lead.claimNumber && lead.insCarrier),
    _hasContact: !!(lead.phone || lead.email),
    _hasAddress: !!lead.address,
    _hasScope: !!(lead.scopeOfWork || est?.description),
    _hasJobValue: !!jobVal,
    _isJobComplete: String(lead.stage||'').toLowerCase().includes('complete')
  };
}
// doc-preflight.js:2137 reads this by name off window (its data-bridge
// fallback for customer.html) -- the only external caller of this
// function, so it needs an explicit export unlike checkPrerequisites
// right below (verified: doc-preflight.js never calls that one, only
// mentions it in a header comment -- dashboard-bootstrap.module.js's
// polyfill for it is unused dead infrastructure, out of scope here).
window.getCustomerDocData = getCustomerDocData;

function checkPrerequisites(type, data) {
  const prereq = DOC_PREREQUISITES[type];
  if (!prereq) return { ok: true };
  // Each entry keeps the `need` id (not just its human text) so the
  // Can't-Generate modal's "Fix" button knows which existing UI to route
  // to — see _fixDocNeed below. `text` is unchanged, still what renders.
  const missing = [];
  for (const need of prereq.needs) {
    switch(need) {
      case 'estimate': if (!data._hasEstimate) missing.push({ need, text: 'Build an estimate' }); break;
      case 'contact': if (!data._hasContact) missing.push({ need, text: 'Add phone or email' }); break;
      case 'address': if (!data._hasAddress) missing.push({ need, text: 'Add property address' }); break;
      case 'scope': if (!data._hasScope) missing.push({ need, text: 'Add scope of work' }); break;
      case 'photos': if (!data._hasPhotos) missing.push({ need, text: 'Upload inspection photos' }); break;
      case 'claim': if (!data._hasClaim) missing.push({ need, text: 'Add insurance carrier & claim number' }); break;
      case 'jobValue': if (!data._hasJobValue) missing.push({ need, text: 'Add job value or build estimate' }); break;
      case 'jobComplete': if (!data._isJobComplete) missing.push({ need, text: 'Mark job as Complete' }); break;
      case 'beforeAfterPhotos': if (!data._hasBeforeAfterPhotos) missing.push({ need, text: 'Upload both Before AND After photos' }); break;
    }
  }
  return missing.length > 0 ? { ok: false, missing, label: prereq.label, msg: prereq.msg } : { ok: true };
}

// ─────────────────────────────────────────────────────────────────
// "Fix the issue" routing — takes a rep from the Can't-Generate modal
// straight to the existing UI that captures the missing field, instead
// of a "Got it" dead end. No new editors: every target already exists.
// `estimate` and `photos`/`beforeAfterPhotos` have no single field to
// focus, so those just scroll the matching section into view; jobComplete
// can't be auto-advanced (stage moves one step at a time), so it scrolls
// to and pulses the existing "Move to Next Stage" control instead.
// ─────────────────────────────────────────────────────────────────
function _pulseTarget(el) {
  if (!el) return;
  el.style.transition = 'box-shadow .2s ease';
  const prevShadow = el.style.boxShadow;
  el.style.boxShadow = '0 0 0 3px var(--orange)';
  setTimeout(() => { el.style.boxShadow = prevShadow; }, 1600);
}

window._fixDocNeed = function (need) {
  const scrollTo = (id) => {
    const el = document.getElementById(id);
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); _pulseTarget(el); }
  };
  const focusInModal = (fieldId) => {
    if (typeof window.openEditCustomerModal === 'function') window.openEditCustomerModal();
    setTimeout(() => { const f = document.getElementById(fieldId); if (f) { f.focus(); if (f.select) f.select(); } }, 120);
  };
  switch (need) {
    case 'contact': focusInModal('editPhone'); break;
    case 'address': focusInModal('editAddress'); break;
    case 'scope': focusInModal('editScope'); break;
    case 'jobValue': focusInModal('editJobValue'); break;
    case 'claim':
      scrollTo('insurancePanel');
      setTimeout(() => { if (typeof window.openClaimEditor === 'function') window.openClaimEditor(); }, 300);
      break;
    case 'estimate': scrollTo('estimatesPanelTitle'); break;
    case 'photos':
    case 'beforeAfterPhotos':
      scrollTo('photosTab');
      break;
    case 'jobComplete': scrollTo('stageProgressBtn'); break;
    default: break;
  }
};

// ─────────────────────────────────────────────────────────────────
// Blank-preview escape hatch. Lets a rep render any template even
// when prereqs aren't met — useful for:
//   - "what does this doc look like?" before gathering data
//   - showing the customer a blank preview so they know what's coming
//   - QA / spot-checking templates after a template change
// Renders the doc with real data WHERE AVAILABLE, sentinel placeholders
// (e.g. "[Customer name]") where fields are missing. Skips DocPreflight
// and the prereq check entirely. Output goes to the standard
// NBDDocGen.generate viewer, with a banner marking it as a preview.
// ─────────────────────────────────────────────────────────────────
function _blankifyDocData(realData) {
  const out = Object.assign({}, realData || {});
  // Substitute placeholders for empty primitives so templates that do
  // `data.firstName.toUpperCase()` produce something legible instead
  // of empty strings or undefined-crashes.
  const placeholders = {
    firstName: '[First Name]',
    lastName: '[Last Name]',
    name: '[Customer Name]',
    fullName: '[Customer Name]',
    homeownerName: '[Customer Name]',
    email: '[customer@email.com]',
    phone: '[(555) 555-5555]',
    address: '[123 Main St, City, State]',
    propertyAddress: '[123 Main St, City, State]',
    claimNumber: '[Claim #]',
    insCarrier: '[Carrier]',
    insuranceCarrier: '[Carrier]',
    policyNumber: '[Policy #]',
    dateOfLoss: '[Date of Loss]',
    scopeOfWork: '[Scope of work — to be added]',
    jobType: '[Job type]',
    damageType: '[Damage type]',
    jobValue: '[Job value]',
    estimateTotal: '[Estimate total]',
    warrantyTier: '[Warranty tier]',
  };
  for (const k in placeholders) {
    if (out[k] == null || out[k] === '' || out[k] === 0) out[k] = placeholders[k];
  }
  out._isBlankPreview = true;
  return out;
}

window._previewBlankDoc = async function (type) {
  // Docgen is lazy (ScriptLoader 'docgen') — fetch it on first use instead of
  // telling the rep it is "loading..." and doing nothing.
  if (!window.NBDDocGen && window.ScriptLoader && typeof window.ScriptLoader.loadBundle === 'function') {
    await window.ScriptLoader.loadBundle('docgen');
  }
  if (!window.NBDDocGen) {
    showToast('Document generator loading...', 'error');
    return;
  }
  const realData = getCustomerDocData();
  const blank = _blankifyDocData(realData);
  // Quick visible toast so the rep knows this is a preview, not a
  // real doc. The viewer itself doesn't currently have a "draft"
  // watermark; tracking it via _isBlankPreview on the data object
  // gives templates a hook to render one in the future.
  showToast('Blank preview — fields shown in brackets are missing.', 'info');
  try {
    window.NBDDocGen.generate(type, blank);
  } catch (err) {
    console.error('[blank-preview]', type, 'failed:', err);
    showToast('Preview failed: ' + (err && err.message || err), 'error');
  }
};

// ─────────────────────────────────────────────────────────────────
// Create Document picker — searchable, stage-aware modal of the
// generatable doc templates. Clicking a card closes the modal and
// drops the rep into the existing generateCustomerDoc(type) flow
// (preflight → render). "See full document library" scrolls to the
// on-page Generate Documents grid, which exposes blank-template
// previews per card.

window._DOC_TEMPLATE_CATALOG = [
  { type:'proposal',                  icon:'📄', name:'Proposal / Estimate',      desc:'Branded estimate with scope & pricing',     cats:['sales'],             kw:'estimate bid quote pricing offer' },
  { type:'contract',                  icon:'📝', name:'Roofing Contract',         desc:'Full contract with terms & signatures',     cats:['sales'],             kw:'agreement sign signature legal' },
  { type:'work_authorization',        icon:'✅', name:'Work Authorization',       desc:'Permission to proceed form',                cats:['sales','install'],   kw:'authorize permission proceed start go-ahead' },
  { type:'scope_of_work',             icon:'📋', name:'Scope of Work',            desc:'Detailed project scope breakdown',          cats:['sales','claim'],     kw:'scope breakdown line-items work' },
  { type:'inspectionHomeowner',       icon:'🔎', name:'Inspection Report',        desc:'Homeowner-friendly inspection report',      cats:['inspection'],        kw:'inspection damage assessment roof customer homeowner' },
  { type:'inspectionInsurance',       icon:'🏢', name:'Insurance Report',         desc:'Adjuster-ready inspection report',          cats:['inspection','claim'],kw:'insurance adjuster carrier claim damage assessment' },
  { type:'supplement_request',        icon:'📈', name:'Supplement Request',       desc:'Additional scope supplement for insurance', cats:['claim'],             kw:'supplement supp additional extra insurance adjuster' },
  { type:'warranty_certificate',      icon:'🛡', name:'Warranty Certificate',     desc:'Branded warranty with tier details',        cats:['closeout'],          kw:'warranty guarantee coverage tier' },
  { type:'certificate_of_completion', icon:'🏆', name:'Certificate of Completion',desc:'Final sign-off & completion record',        cats:['closeout'],          kw:'completion final sign-off coc finish done' },
  { type:'invoice',                   icon:'💰', name:'Invoice',                  desc:'Professional payment invoice',              cats:['closeout'],          kw:'bill payment pay due balance receipt' },
  { type:'receipt',                   icon:'🧾', name:'Receipt',                  desc:'Proof of payment for money received',       cats:['closeout'],          kw:'receipt paid payment proof thank' },
  { type:'change_order',              icon:'🔄', name:'Change Order',             desc:'Scope or price modification form',          cats:['install'],           kw:'change order co modify modification scope price', draft:true },
  // Template library (2026-10-04). draft:true = Jo's attorney has not yet
  // reviewed it: the card says so here, never on the customer's copy.
  { type:'lien_waiver',               icon:'🔐', name:'Lien Waiver',              desc:'Conditional / unconditional, progress / final (OH & KY)', cats:['closeout','claim'], kw:'lien waiver release mortgage check endorse conditional unconditional progress final', draft:true },
  { type:'right_to_cancel',           icon:'⏱️', name:'Right to Cancel',          desc:'3-business-day cancellation notice + forms', cats:['sales'],          kw:'cancel cancellation rescind 3 day three day notice home solicitation ftc cooling off', draft:true },
  { type:'material_selection',        icon:'🎨', name:'Material & Color Selection', desc:'Shingle, drip edge, vents, gutters — homeowner sign-off', cats:['sales','install'], kw:'color colour shingle drip edge vent gutter selection materials sign off' },
  { type:'proposal_options',          icon:'⚖️', name:'Good-Better-Best Options', desc:'One-page comparison of every priced package', cats:['sales'],             kw:'good better best tiers options compare comparison packages economy beyond' },
  { type:'insurance_next_steps',      icon:'📬', name:'Insurance Next Steps',     desc:'Homeowner letter: who does what on an insurance job', cats:['claim','inspection'], kw:'insurance claim letter next steps scope adjuster homeowner kentucky' },
  { type:'before_after_report',       icon:'📷', name:'Before & After Report',    desc:'Visual transformation with photos',         cats:['closeout','sales'],  kw:'before after photos comparison transformation review' },
  { type:'financing_options',         icon:'💳', name:'Financing Options',        desc:'Payment plan options for customer',         cats:['sales'],             kw:'finance financing loan payment plan monthly' },
  { type:'company_intro',             icon:'🏠', name:'Company Introduction',     desc:'About us packet for new prospects',         cats:['sales'],             kw:'about us intro company brochure packet new prospect' },
  { type:'referral_card',             icon:'🎁', name:'Referral Card',            desc:'Shareable referral with incentives',        cats:['closeout'],          kw:'refer referral review incentive share' },
  { type:'storm_history_report',      icon:'⛈️', name:'Storm History Report',     desc:'Free 5-yr NOAA hail & wind history — skip the paid GAF report', cats:['claim','inspection'], kw:'storm hail wind weather history noaa nws gaf 5-year verification report' }
];

window._STAGE_TEMPLATE_PRIORITY = {
  'new':                        ['sales','inspection'],
  'contacted':                  ['sales','inspection'],
  'inspected':                  ['inspection','sales'],
  'claim_filed':                ['claim','inspection'],
  'adjuster_meeting_scheduled': ['claim','inspection'],
  'adjuster_inspection_done':   ['claim','inspection'],
  'scope_received':             ['claim','sales'],
  'estimate_submitted':         ['sales','claim'],
  'supplement_requested':       ['claim','sales'],
  'supplement_approved':        ['sales','install'],
  'contract_signed':            ['sales','install'],
  'job_created':                ['install'],
  'permit_pulled':              ['install'],
  'materials_ordered':          ['install'],
  'materials_delivered':        ['install'],
  'crew_scheduled':             ['install'],
  'install_in_progress':        ['install','closeout'],
  'install_complete':           ['closeout','install'],
  'final_photos':               ['closeout'],
  'deductible_collected':       ['closeout'],
  'final_payment':              ['closeout'],
  'closed':                     ['closeout']
};

function _orderedDocTemplates() {
  var stage = window._currentStage || 'new';
  var priority = window._STAGE_TEMPLATE_PRIORITY[stage] || ['sales','inspection'];
  return window._DOC_TEMPLATE_CATALOG
    .map(function(t, idx) {
      var bestRank = priority.length;
      t.cats.forEach(function(c) {
        var r = priority.indexOf(c);
        if (r !== -1 && r < bestRank) bestRank = r;
      });
      return { t: t, rank: bestRank, idx: idx };
    })
    .sort(function(a, b) { return (a.rank - b.rank) || (a.idx - b.idx); })
    .map(function(s) { return s.t; });
}

function _renderDocCreateGrid(filter) {
  var esc = window.nbdEsc || function(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]});};
  var q = String(filter || '').trim().toLowerCase();
  var list = _orderedDocTemplates().filter(function(t) {
    if (!q) return true;
    return t.name.toLowerCase().indexOf(q) !== -1
        || t.desc.toLowerCase().indexOf(q) !== -1
        || t.type.toLowerCase().indexOf(q) !== -1
        || (t.kw && t.kw.toLowerCase().indexOf(q) !== -1);
  });
  var grid = document.getElementById('docCreateGrid');
  var empty = document.getElementById('docCreateEmpty');
  if (!grid) return;
  if (list.length === 0) {
    grid.innerHTML = '';
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';
  grid.innerHTML = list.map(function(t) {
    return '<div class="doc-template-card" data-action="_pickCustomerDoc" data-doc-type="' + esc(t.type) + '" '
      + 'style="position:relative;padding:14px;background:var(--s2);border-radius:10px;border:1px solid var(--br);cursor:pointer;transition:all .2s;">'
      + '<button type="button" class="dt-preview-btn" data-action="_previewBlankDoc" data-doc-type="' + esc(t.type) + '" aria-label="Preview blank template" title="Preview blank template">&#9432;</button>'
      + '<div class="ct-icon">' + t.icon + '</div>'
      + '<div class="ct-title-sm">' + esc(t.name) + '</div>'
      + '<div class="ct-sub">' + esc(t.desc) + '</div>'
      + (t.draft ? '<div class="dt-draft-badge" data-attorney-review="true">DRAFT — have your attorney review before first use</div>' : '')
      + '</div>';
  }).join('');
}

window.openDocCreateModal = function() {
  // 2026-09-25: a viewer is read-only (Jo's decision B; role-gate.js).
  if (window.NBDRole && !window.NBDRole.guard()) return;
  var modal = document.getElementById('docCreateModal');
  if (!modal) return;
  modal.setAttribute('aria-hidden', 'false');
  var search = document.getElementById('docCreateSearch');
  if (search) search.value = '';
  _renderDocCreateGrid('');
  // onClose restores aria-hidden on every dismiss path (button, Esc, backdrop),
  // which nbdModal now owns — the hand-rolled backdrop/Esc listeners below were
  // removed in the batch-4 consolidation.
  window.nbdModal.open('docCreateModal', { onClose: function() {
    modal.setAttribute('aria-hidden', 'true');
  } });
  if (search) setTimeout(function() { try { search.focus(); } catch (_) {} }, 50);
};

window.closeDocCreateModal = function() {
  window.nbdModal.close('docCreateModal');
};

window._pickCustomerDoc = function(type) {
  window.closeDocCreateModal();
  window.generateCustomerDoc(type);
};

window._seeAllDocTemplates = function() {
  window.closeDocCreateModal();
  var target = document.getElementById('documentsTab');
  if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

// Live filter as the user types in the picker search box.
document.addEventListener('input', function _docCreateSearchListener(e) {
  if (e.target && e.target.id === 'docCreateSearch') {
    _renderDocCreateGrid(e.target.value);
  }
});

// Backdrop click + Esc dismiss are handled by nbdModal (batch-4 consolidation).

window.generateCustomerDoc = async function(type) {
  // 2026-09-25: a viewer is read-only (Jo's decision B; role-gate.js).
  if (window.NBDRole && !window.NBDRole.guard()) return;
  // Docgen is lazy (ScriptLoader 'docgen'). Both NBDDocGen and DocPreflight
  // ride that one bundle, so this single await covers the pre-flight branch
  // below as well — without it that branch would silently skip the review
  // modal and generate straight from unreviewed data.
  if (!window.NBDDocGen && window.ScriptLoader && typeof window.ScriptLoader.loadBundle === 'function') {
    showToast('Preparing document generator…', 'info');
    await window.ScriptLoader.loadBundle('docgen');
  }
  if (!window.NBDDocGen) {
    showToast('Document generator loading...', 'error');
    return;
  }

  const data = getCustomerDocData();
  const check = checkPrerequisites(type, data);

  if (!check.ok) {
    // Show prerequisite warning with specific missing items.
    // Two CTAs: "Got It" (acknowledge), and the new "Preview blank
    // template" escape hatch — the rep can still see the doc layout
    // even when data isn't ready, useful for showing the customer
    // what's coming or QA-ing the template itself.
    const esc = window.nbdEsc || (s => String(s == null ? '' : s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])));
    const label = check.label || type;
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:var(--z-overlay);background:rgba(0,0,0,.8);display:flex;align-items:center;justify-content:center;';
    modal.innerHTML = `
      <div class="ct-dialog">
        <div class="ct-icon-lg">⚠️</div>
        <div class="ct-dialog-title">Can't Generate ${esc(label)}</div>
        <div class="ct-dialog-sub">This document requires data that hasn't been added yet:</div>
        <div class="ct-preq-list">
          ${check.missing.map(m => '<div class="ct-preq-row">'
            + '<span>• ' + esc(m.text) + '</span>'
            + '<button type="button" class="nbd-preq-fix ct-preq-fix" data-need="' + esc(m.need) + '">Fix &rarr;</button>'
            + '</div>').join('')}
        </div>
        <div class="ct-actions-center">
          <button class="nbd-preq-preview ct-dialog-btn">👁 Preview blank template</button>
          <button class="nbd-preq-close ct-dialog-btn-primary">Got It</button>
        </div>
      </div>`;
    modal.querySelector('.nbd-preq-close').addEventListener('click', () => modal.remove());
    modal.querySelector('.nbd-preq-preview').addEventListener('click', () => {
      modal.remove();
      window._previewBlankDoc(type);
    });
    modal.querySelectorAll('.nbd-preq-fix').forEach((btn) => {
      btn.addEventListener('click', () => {
        modal.remove();
        window._fixDocNeed(btn.dataset.need);
      });
    });
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    return;
  }

  // All prerequisites met — open pre-flight modal so the user can
  // review/edit every field before generation. Falls back to direct
  // generate if the pre-flight module has not yet loaded.
  if (window.DocPreflight && typeof window.DocPreflight.open === 'function') {
    window.DocPreflight.open(type, window._customerId);
    return;
  }
  window.NBDDocGen.generate(type, data);
  logGeneratedDoc(type, data);
};

// ─────────────────────────────────────────────────────────────────
// Tiny wrapper functions for inline DOM tweaks that previously
// lived inside onclick="..." strings. The strict CSP blocks the
// raw inline JS, but each of these is trivially expressed as a
// named function that the delegate below can dispatch to.
function _closeGallerySharePanel() {
  var el = document.getElementById('gallerySharePanel');
  if (el) el.style.display = 'none';
}
function _closePhotoActionPopup() {
  var el = document.getElementById('photoActionPopup');
  if (el) el.remove();
}
function _triggerFileInput() {
  var el = document.getElementById('fileInput');
  if (el) el.click();
}
function _openInDashboardEstimate() {
  if (window._customerId) {
    window.location.href = '/pro/dashboard?lead=' + window._customerId;
  }
}
// 2026-09-17: same navigate-with-lead-context pattern as the estimate
// button above — Job Templates has no in-page UI on customer.html (it
// rides the dashboard's own JobTemplatesUI picker), so this hands off to
// dashboard-bootstrap.module.js's ?lead=&templates=1 deep link, which opens
// the SAME openJobTemplatesForLead() the dashboard's card-detail "Template
// Quote" button uses — no second picker implementation.
function _openInDashboardJobTemplates() {
  if (window._customerId) {
    window.location.href = '/pro/dashboard?lead=' + window._customerId + '&templates=1';
  }
}
function _openPhotoInEditorAndClose(idx) {
  // data-arg is always a string; coerce so array indexing works.
  if (typeof openPhotoInEditor === 'function') openPhotoInEditor(+idx);
  _closePhotoActionPopup();
}
function _previewPhotoFromPopup(idx) {
  // Preview = "just look at the photo at full size." The action popup
  // (showPhotoActions) handled phase/damage/severity edits + Open
  // Editor + Delete, but had no plain "view it bigger" affordance.
  // openPhotoLightbox is the simple <div id="lightbox"> viewer already
  // defined further down; we just hand it the URL + description and
  // close the popup so the user sees the image fullscreen.
  var photo = (window._allPhotos || [])[+idx];
  if (!photo) return;
  if (typeof openPhotoLightbox === 'function') {
    // _allPhotos + idx: the arrows must step through the same list the rep
    // was looking at when they opened the popup.
    openPhotoLightbox(photo.url, photo.description || '', window._allPhotos || [], +idx);
  }
  _closePhotoActionPopup();
}
function _sendReferralCodeAndSms() {
  if (!window.ReviewEngine || !window._customerId) return;
  ReviewEngine.assignReferralCode(window._customerId).then(function (c) {
    if (c) ReviewEngine.sendReferralSMS(window._customerId);
  });
}
// onchange wrappers — multi-statement or shape-adapting handlers
function _applyBulkPhotoUpdateAndReset(field, el) {
  if (typeof window.applyBulkPhotoUpdate === 'function') {
    window.applyBulkPhotoUpdate(field, el.value);
  }
  el.value = '';
}
function _handleFileSelectFromEl(el) {
  // Original handleFileSelect(event) reads event.target.files; the
  // delegate hands us the input el directly, so synthesize a minimal
  // event-shaped object.
  if (typeof handleFileSelect === 'function') {
    handleFileSelect({ target: el });
  }
}
window._closeGallerySharePanel       = _closeGallerySharePanel;
window._closePhotoActionPopup        = _closePhotoActionPopup;
window._triggerFileInput             = _triggerFileInput;
window._openInDashboardEstimate      = _openInDashboardEstimate;
window._openInDashboardJobTemplates  = _openInDashboardJobTemplates;
window._openPhotoInEditorAndClose    = _openPhotoInEditorAndClose;
window._previewPhotoFromPopup        = _previewPhotoFromPopup;
window._sendReferralCodeAndSms       = _sendReferralCodeAndSms;
window._applyBulkPhotoUpdateAndReset = _applyBulkPhotoUpdateAndReset;
window._handleFileSelectFromEl       = _handleFileSelectFromEl;

// ─────────────────────────────────────────────────────────────────
// CSP-safe action delegate for customer.html.
// Why this exists: the prod /pro/customer CSP at firebase.json:80
// has `script-src-attr 'none'`, which silently blocks every inline
// event handler (onclick, onmouseover, etc.). Every button on the
// page previously broke. Mirror of the dashboard.html C.4/C.5
// migration pattern.
//
// Markup contract:
//   <button data-action="funcName">…</button>
//     → calls window.funcName()
//
//   <button data-action="Namespace.method">…</button>
//     → walks dotted path: window.Namespace.method()
//
//   <button data-action="funcName" data-arg="x" data-arg2="y" data-arg3="z">…</button>
//     → window.funcName('x', 'y', 'z')   (positional, up to 3 string args)
//
//   <button data-action="funcName" data-pass-customer-id="true">…</button>
//     → window.funcName(window._customerId, …)   (prepended)
//
//   <button data-action="funcName" data-pass-el="true">…</button>
//     → window.funcName(…, clickedEl)            (appended)
//
// Unknown actions log a console.error so missed migrations are
// visible in dev tools instead of silently no-op'ing.
// ─────────────────────────────────────────────────────────────────
function _nbdCustomerActionDispatch(action, el) {
  // Walk dotted action names so "ReviewEngine.sendReviewSMS" finds
  // window.ReviewEngine.sendReviewSMS without a separate registration.
  var fn = action.split('.').reduce(function (o, k) { return o ? o[k] : null; }, window);
  if (typeof fn !== 'function') {
    console.error('[customer-action] unknown action:', action);
    return;
  }
  // Build the args list in invocation order.
  var args = [];
  if (el.dataset.passCustomerId === 'true') args.push(window._customerId);
  // data-doc-type is the legacy alias for data-arg from the §430
  // doc-template-card migration. Honor both so previously-migrated
  // markup keeps working.
  if (el.dataset.docType !== undefined) args.push(el.dataset.docType);
  else if (el.dataset.arg !== undefined) args.push(el.dataset.arg);
  if (el.dataset.arg2 !== undefined) args.push(el.dataset.arg2);
  if (el.dataset.arg3 !== undefined) args.push(el.dataset.arg3);
  if (el.dataset.passEl === 'true') args.push(el);
  try {
    fn.apply(window, args);
  } catch (err) {
    console.error('[customer-action]', action, 'failed:', err);
  }
}

// Click delegate — fires on [data-action] elements.
// Keyboard parity for the action delegate.
//
// 25 elements on this page carry data-action on a <div> or <span> — the 15
// document-template cards, the 8 timeline filter pills, and both upload drop
// zones. A click-only delegate made the entire Generate Documents feature and
// the entire timeline filter unreachable without a mouse.
//
// Registered once, next to the click delegate, so anything that gains a
// data-action later is keyboard-operable by construction rather than by
// somebody remembering.
//
// NATIVE controls are skipped deliberately: a <button> or <a> already turns
// Enter/Space into a click, so handling the key here as well would dispatch
// every action twice. Space is also swallowed on non-native controls to stop
// the page scrolling underneath the activation.
document.addEventListener('keydown', function _nbdCustomerKeyDelegate(e) {
  if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  var el = e.target && e.target.closest && e.target.closest('[data-action]');
  if (!el) return;
  if (/^(BUTTON|A|INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) return;
  var action = el.dataset && el.dataset.action;
  if (!action) return;
  e.preventDefault();
  _nbdCustomerActionDispatch(action, el);
});

document.addEventListener('click', function _nbdCustomerClickDelegate(e) {
  var el = e.target && e.target.closest && e.target.closest('[data-action]');
  if (!el) return;
  var action = el.dataset && el.dataset.action;
  if (!action) return;
  e.preventDefault();
  _nbdCustomerActionDispatch(action, el);
});

// Change delegate — fires on [data-change-action] elements (selects,
// file inputs, text inputs). Uses a separate attribute so the
// dispatch is unambiguous: a <select data-change-action="..."> fires
// on the change event (when the user picks an option), not on the
// click that opens the dropdown.
document.addEventListener('change', function _nbdCustomerChangeDelegate(e) {
  var el = e.target && e.target.closest && e.target.closest('[data-change-action]');
  if (!el) return;
  var action = el.dataset && el.dataset.changeAction;
  if (!action) return;
  _nbdCustomerActionDispatch(action, el);
});

// Called by doc-preflight.js after a successful generation.
//
// This used to build a DOM row and insertBefore it into #generatedDocList —
// pure DOM, never read back from Firestore. The list therefore emptied itself
// on every reload, so a rep who generated a contract on Monday saw "Generate a
// document above to see it here" on Tuesday. The generator DOES persist to
// leads/{leadId}/documents (document-generator.js), so the honest fix is to
// re-read the store and let it paint the row from what was actually saved.
function logGeneratedDoc(type, data) {
  if (!window.NBDCustomerDocs) return;
  // The generator persists in the background and resolves the viewer before
  // the write necessarily lands. Refresh now for the common case, and once
  // more shortly after to pick up a slow write. Both are idempotent re-reads.
  window.NBDCustomerDocs.refresh();
  setTimeout(function () { window.NBDCustomerDocs.refresh(); }, 2500);
}

window.openDocUploadModal = function() {
  window.nbdModal.open('docUploadModal');
};

window.closeDocUploadModal = function() {
  window.nbdModal.close('docUploadModal');
};

// ── Load all new sections when customer loads ───
// loadPhotosByPhase used to run in this bundle too. It now runs earlier,
// alongside loadPhotos(), via customer-bootstrap.module.js's
// loadAllCustomerPhotos() (called right after the customer doc loads) —
// one shared fetch feeds both #photoList and #photosByPhase instead of
// each loader running its own independent getDocs(). loadNewPortalSections
// has exactly one caller (customer-bootstrap.module.js's loadCustomerData),
// in that same page-load sequence, so removing it here doesn't leave any
// other caller without a phase-grid load.
async function loadNewPortalSections(leadId) {
  try {
    await Promise.all([
      window.loadProjectTimeline(leadId),
      window.loadInvoices(leadId),
      window.loadReports(leadId),
      loadCommunicationLog(leadId)
    ]);
  } catch (error) {
    console.error('Error loading portal sections:', error);
  }
}

// ── Setup contact tab links ────────────────────
function setupContactTab(customerData) {
  // B-3c: contractor banner + contact links resolve from the active tenant.
  // NBD (default brand) keeps the exact hardcoded values — byte-identical.
  const _b = (window._brand && window._brand()) || {};
  const _isNbd = !_b.legalName || _b.legalName === 'No Big Deal Home Solutions';
  // M1: a non-NBD tenant that didn't set its own phone/email shows BLANK, never
  // NBD's number/address — window._brand() already blanks fields the tenant
  // didn't set, and these fallbacks no longer reach back to the NBD literals.
  const phone = _isNbd ? '(859) 420-7382' : ((_b.contact && _b.contact.phone) || '');
  const email = _isNbd ? 'info@nobigdealwithjoedeal.com' : ((_b.contact && _b.contact.email) || '');

  document.getElementById('contractorPhone').textContent = phone;
  // These dial the CONTRACTOR (this tenant), never the customer — the
  // customer's own Call/Email are the header buttons. Name them explicitly:
  // three unlabelled icon buttons under a company banner on a page about a
  // customer read as "call the customer", which is how they ended up wired
  // to a customer-communication logger. Screen readers got "Call" alone too.
  const _who = (_isNbd ? 'No Big Deal Home Solutions' : (_b.legalName || 'your company'));
  const _mark = (id, verb, href) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.href = href;
    el.setAttribute('aria-label', verb + ' ' + _who);
    el.title = verb + ' ' + _who + ' (not the customer)';
  };
  _mark('contactCallBtn', 'Call', `tel:${phone.replace(/\D/g, '')}`);
  _mark('contactTextBtn', 'Text', `sms:${phone.replace(/\D/g, '')}`);
  _mark('contactEmailBtn', 'Email', `mailto:${email}`);
  if (!_isNbd) {
    const elS = document.getElementById('contractorSeal'); if (elS) elS.textContent = _b.seal || '';
    const elN = document.getElementById('contractorName'); if (elN) elN.textContent = _b.legalName || '';
  }
}

// ── Open Photo in Lightbox ─────────────────────
// srcArray/idx are optional, but every caller that indexed into an array MUST
// pass both. The lightbox's next/prev arrows live in customer-bootstrap.module.js
// and walk a module-scoped cursor this file structurally cannot set, so an
// open-by-URL left the arrows stepping through whatever array was loaded last.
// setLightboxSource (registry-only since Globals Tranche 3 T3-C, 2026-09-18
// — not window) is that module's setter; hand it the array we actually
// indexed into. _allPhotos and _customerPhotos differ in LENGTH (the
// team-read path drops the userId filter), so one array's cursor
// addressing the other doesn't just reorder photos — it goes out of bounds.
window.openPhotoLightbox = function(url, description, srcArray, idx) {
  // DISPLAY FIRST, then hand over the cursor. setLightboxSource is a
  // cursor-setter only — it stores the array the ‹ › arrows should walk and
  // displays nothing. Returning early on it (as an earlier revision did) meant
  // the lightbox never opened at all, and passing (url, description, …) into a
  // two-arg (srcArray, idx) setter nulled _lightboxSource, forcing the arrows
  // back onto window._customerPhotos — the exact cross-customer bug the
  // handshake exists to prevent.
  const lightbox = document.getElementById('lightbox');
  const img = document.getElementById('lightboxImg');
  if (lightbox && img) {
    img.src = url;
    if (description) img.alt = description;
    lightbox.classList.add('active');
    // Pairs with the `document.body.style.overflow = ''` reset in the canonical
    // closeLightbox (customer-bootstrap.module.js).
    document.body.style.overflow = 'hidden';
  }
  // Hand the arrows the array we actually indexed into. The two customer photo
  // arrays differ in LENGTH (window._customerPhotos drops the userId filter for
  // team readers; _allPhotos always filters by uid), so one array's cursor must
  // never address the other.
  var _nbdReg = window.__NBD_CALL_REGISTRY;
  if (Array.isArray(srcArray) && _nbdReg && typeof _nbdReg.setLightboxSource === 'function') {
    _nbdReg.setLightboxSource(srcArray, Number(idx) || 0);
  }
};

// closeLightbox is deliberately NOT defined here. This file loads after
// customer-bootstrap.module.js, so the duplicate that used to sit on this
// line won the page — and it omitted the `document.body.style.overflow = ''`
// reset that openLightbox's `overflow:hidden` depends on, leaving the page
// permanently scroll-locked after the first close. The complete definition
// in customer-bootstrap.module.js now takes effect.

console.log('✓ Customer page enhancements loaded');
})();


// ── nbd jump-nav scroll-spy (consolidation 2026-07-19) ─────────────────
// The single-page customer record replaced tabs with a sticky jump-nav but
// nothing indicated the current section. IntersectionObserver toggles
// .active on the matching link. CSP-safe: no inline handlers.
//
// 2026-09-25 (phone audit): on a phone the bar is a sideways scroller that
// shows ~3 of its 7 chips, and this only ever toggled the class — so the
// highlighted chip was usually scrolled out of sight (at Voice Intel it sat
// at x=446-536 in a bar ending at 306), and after tapping Contact and
// scrolling back up, the active Overview chip was at x=-299. The bar now
// brings the active chip into view. It scrolls the BAR only, never the
// page: scrollIntoView() would also drag the page to the bar while it is
// still below the fold at scroll 0. Above the first section nothing is
// current, so nothing stays lit there.
// It also publishes the bar's live height as --jump-nav-h, which the
// photo bulk-action bar uses to pin BELOW the bar instead of under it.
(function () {
  function initSpy() {
    var nav = document.querySelector('.jump-nav');
    if (!nav) return;
    var root = document.documentElement;
    var publishHeight = function () {
      if (nav.offsetHeight) root.style.setProperty('--jump-nav-h', nav.offsetHeight + 'px');
    };
    publishHeight();
    if ('ResizeObserver' in window) new ResizeObserver(publishHeight).observe(nav);
    if (!('IntersectionObserver' in window)) return;
    var links = Array.prototype.slice.call(nav.querySelectorAll('a[href^="#"]'));
    if (!links.length) return;
    var map = {};
    links.forEach(function (a) {
      var id = a.getAttribute('href').slice(1);
      var sec = document.getElementById(id);
      if (sec) map[id] = a;
    });
    var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    function reveal(a) {
      if (nav.scrollWidth <= nav.clientWidth + 1) return; // everything already shows
      var nb = nav.getBoundingClientRect();
      var ab = a.getBoundingClientRect();
      // 28px = the right-edge mask fade (customer.html, ≤768px) — a chip
      // under the fade reads as "more this way", not as visible.
      if (ab.left >= nb.left && ab.right <= nb.right - 28) return;
      var delta = (ab.left + ab.width / 2) - (nb.left + nb.width / 2);
      try { nav.scrollBy({ left: delta, behavior: reduceMotion ? 'auto' : 'smooth' }); }
      catch (e) { nav.scrollLeft += delta; }
    }
    var ids = Object.keys(map);
    var inBand = {};
    var io = new IntersectionObserver(function (entries) {
      // Book-keep the whole batch first: one callback can carry a leave
      // and an enter, and deciding on the leave alone would blink the
      // highlight off between two sections.
      var entered = null;
      entries.forEach(function (en) {
        if (en.isIntersecting) { inBand[en.target.id] = true; entered = en.target.id; }
        else delete inBand[en.target.id];
      });
      if (entered) {
        links.forEach(function (a) { a.classList.remove('active'); });
        var a = map[entered];
        if (a) { a.classList.add('active'); reveal(a); }
      } else if (!Object.keys(inBand).length) {
        // Nothing in the band. Above the first section (the customer
        // header) no chip is current; anywhere else keep the last one.
        var first = document.getElementById(ids[0]);
        if (first && first.getBoundingClientRect().top > window.innerHeight * 0.2) {
          links.forEach(function (a) { a.classList.remove('active'); });
        }
      }
    }, { rootMargin: '-20% 0px -70% 0px' });
    ids.forEach(function (id) { io.observe(document.getElementById(id)); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initSpy);
  else initSpy();
})();
