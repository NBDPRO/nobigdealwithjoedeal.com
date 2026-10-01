/**
 * jobs-store.js — a customer's JOBS on the client (2026-09-30, stage 1 of
 * "a customer can have more than one job"; plan:
 * documentation/projects/CRM-JOBS-AND-MONEY-PAPER-PLAN-2026-09-30.md).
 *
 * The model: /leads/{id} is the CUSTOMER; each piece of work is a job at
 * leads/{id}/jobs/{jobId}; lead.activeJobId names the job the lead's own
 * fields (stage, jobValue, scheduledDate, …) describe. The server mirror
 * (functions/jobs-mirror.js) copies those lead fields onto the active job.
 *
 *   NBDJobs.load()                    one collection-group query for the
 *                                     tenant's jobs (staff: companyId, rep:
 *                                     userId), cached by lead
 *   NBDJobs.forLead(leadId)           that customer's jobs, oldest first
 *   NBDJobs.cardsFor(lead, jobs)      PURE — the pipeline cards for a
 *                                     customer (Jo J3, below)
 *   NBDJobs.update(lead, jobId, patch)  routes an edit: the ACTIVE job's edit
 *                                     goes to the lead (the mirror follows);
 *                                     any other job is written directly
 *   NBDJobs.add(lead, fields)         a new job for this customer
 *
 * Jo (J3, 2026-09-30): "show the new job only if we've already collected
 * full payment and the other job is officially closed out, otherwise we can
 * have two open job cards." So a customer shows ONE CARD PER OPEN JOB; with
 * no open job, one card for the most recent job. A job is done only when
 * closed out AND paid in full, or lost (isOpen, same rule as
 * functions/jobs-logic.js).
 *
 * Stage 1 ships the data layer only: nothing calls cardsFor/add yet, so no
 * screen changes. Stage 2 renders the cards and adds "＋ Add job".
 */
(function (root) {
  'use strict';

  // Same list as functions/jobs-logic.js JOB_FIELDS (pinned equal by
  // tests/jobs-stage1-2026-09-30.test.js).
  const JOB_FIELDS = [
    'stage', 'stageRole', 'stageStartedAt', 'stageHistory', 'closedAt', 'lostReason',
    'jobType', 'subType', 'trades', 'jobValue', 'source', 'scopeOfWork', 'damageType',
    'primaryEstimateId', 'openWarrantyClaimId',
    'claimStatus', 'insCarrier', 'claimNumber', 'claimFiledBy', 'policyNumber', 'dateOfLoss',
    'carrierDecisionAt', 'estimateAmount', 'deductibleOrOwedByHO', 'supplementStatus',
    'financeCompany', 'loanAmount', 'loanStatus', 'preQualLink',
    'scheduledDate', 'scheduledWeek', 'scheduledStart', 'scheduledEndDate', 'scheduledDurationMin',
    'adjusterMeetingDate', 'adjusterMeetingStart', 'adjusterName', 'adjusterPhone', 'crew',
    'contractFiledAt', 'permitFiledAt', 'aobFiledAt', 'warrantyCertFiledAt', 'cocFiledAt',
  ];

  const ms = (t) => (t && typeof t.toMillis === 'function') ? t.toMillis()
    : (t instanceof Date ? t.getTime() : (typeof t === 'number' ? t : (Date.parse(t) || 0)));

  function isOpen(job) {
    const j = job || {};
    if (j.stageRole === 'lost') return false;
    const closed = String(j.stage || '').toLowerCase() === 'closed' || (j.stageRole === 'won' && !!j.closedAt);
    return !(closed && j.paidInFull === true);
  }

  /**
   * PURE. The pipeline cards for one customer. Each card is the lead's own
   * object for the ACTIVE job (so every existing renderer keeps working), or
   * a copy of the lead with the other job's fields laid over it, tagged
   * _jobId / _cardKey so an edit can be routed back to that job.
   */
  function cardsFor(lead, jobs) {
    if (!lead) return [];
    const list = (jobs || []).slice().sort((a, b) => ms(a.createdAt) - ms(b.createdAt));
    if (!list.length) return [lead];                       // no jobs loaded / pre-backfill
    const activeId = lead.activeJobId || null;
    const toCard = (j) => {
      if (j.id === activeId) return lead;
      const c = Object.assign({}, lead);
      JOB_FIELDS.forEach((f) => { c[f] = j[f] === undefined ? null : j[f]; });
      c._jobId = j.id;
      c._cardKey = lead.id + ':' + j.id;
      c._jobTitle = j.title || null;
      return c;
    };
    // The active job is judged on the LEAD's fields (the mirror may lag a beat).
    const effective = list.map((j) => (j.id === activeId ? Object.assign({}, j, pick(lead)) : j));
    const open = effective.filter(isOpen);
    if (open.length) return open.map(toCard);
    const newest = effective.slice().sort((a, b) => ms(b.createdAt) - ms(a.createdAt))[0];
    return [toCard(newest)];
  }
  function pick(lead) { const o = {}; JOB_FIELDS.forEach((f) => { if (lead[f] !== undefined) o[f] = lead[f]; }); return o; }

  /**
   * PURE. Every job of these customers as a card-shaped record — for MONEY
   * totals (pipeline value, booked value, average deal, leaderboard revenue),
   * where a customer's second job's value is its own (Jo, 2026-09-30). The
   * lead stands for its active job; each other job — open, won or lost — is
   * the lead with that job's fields laid over it and its stamped stage keys
   * redone from the job's stage (same as the pipeline's cards). A customer
   * with no jobs counts once, as the lead. Counts of CUSTOMERS (leads
   * created, sources, follow-ups) must keep using the leads themselves.
   */
  function records(leads, jobsOf, norm, roleOf) {
    const out = [];
    for (const l of leads || []) {
      if (!l) continue;
      const jobs = (jobsOf && l.id ? jobsOf(l.id) : []) || [];
      if (!jobs.length) { out.push(l); continue; }
      // The card's job not among them (no pointer yet): the lead still counts once.
      if (!jobs.some((j) => j.id === l.activeJobId)) out.push(l);
      for (const j of jobs) {
        if (j.id === l.activeJobId) { out.push(l); continue; }
        const c = Object.assign({}, l);
        JOB_FIELDS.forEach((f) => { c[f] = j[f] === undefined ? null : j[f]; });
        c._jobId = j.id;
        c._cardKey = l.id + ':' + j.id;
        c._jobTitle = j.title || null;
        c._stageKey = norm ? norm(c.stage || 'new') : (c.stage || 'new');
        c._stageRole = c.stageRole || (typeof roleOf === 'function' ? roleOf(c._stageKey) : undefined);
        out.push(c);
      }
    }
    return out;
  }

  /** records() over the loaded jobs; the leads as-is until jobs have loaded. */
  function recordsFor(leads) {
    if (!loadedAt) return (leads || []).slice();
    return records(leads, forLead, root && root.normalizeStage, root && root.stageRole);
  }

  /**
   * PURE. Where an edit to (lead, jobId) must be written:
   *   { target: 'lead' }  the active job (or no jobs yet): write the lead
   *   { target: 'job', jobId }  another job: write leads/{id}/jobs/{jobId}
   */
  function routeFor(lead, jobId) {
    if (!jobId || !lead || jobId === lead.activeJobId) return { target: 'lead' };
    return { target: 'job', jobId: String(jobId) };
  }

  // ── Firestore I/O (browser only) ─────────────────────────────────────
  const byLead = new Map();
  let loadedAt = 0;

  async function load() {
    const w = root;
    if (!w || !w.db || !w.getDocs || !w.query || !w.where) return byLead;
    const claims = w._userClaims || {};
    const uid = w._user && w._user.uid;
    if (!uid) return byLead;
    const mod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
    const staff = ['company_admin', 'manager', 'viewer', 'admin'].includes(claims.role || '') && !!claims.companyId;
    const q = staff
      ? w.query(mod.collectionGroup(w.db, 'jobs'), w.where('companyId', '==', claims.companyId))
      : w.query(mod.collectionGroup(w.db, 'jobs'), w.where('userId', '==', uid));
    const snap = await w.getDocs(q);
    byLead.clear();
    snap.forEach((d) => {
      const leadId = d.ref.parent && d.ref.parent.parent && d.ref.parent.parent.id;
      if (!leadId) return;
      const arr = byLead.get(leadId) || [];
      arr.push(Object.assign({ id: d.id }, d.data()));
      byLead.set(leadId, arr);
    });
    loadedAt = Date.now();
    return byLead;
  }

  /** One customer's jobs (the customer page): leads/{id}/jobs, no index. */
  async function loadLead(leadId) {
    const w = root;
    if (!w || !w.db || !w.getDocs || !w.collection || !leadId) return [];
    const snap = await w.getDocs(w.collection(w.db, 'leads', String(leadId), 'jobs'));
    const arr = [];
    snap.forEach((d) => arr.push(Object.assign({ id: d.id }, d.data())));
    byLead.set(String(leadId), arr);
    return forLead(String(leadId));
  }

  function forLead(leadId) {
    return (byLead.get(leadId) || []).slice().sort((a, b) => ms(a.createdAt) - ms(b.createdAt));
  }

  async function update(lead, jobId, patch) {
    const w = root;
    const r = routeFor(lead, jobId);
    const ref = r.target === 'lead'
      ? w.doc(w.db, 'leads', lead.id)
      : w.doc(w.db, 'leads', lead.id, 'jobs', r.jobId);
    await w.updateDoc(ref, Object.assign({}, patch, { updatedAt: w.serverTimestamp() }));
    if (r.target === 'job') {
      const arr = byLead.get(lead.id) || [];
      const j = arr.find((x) => x.id === r.jobId);
      if (j) Object.assign(j, patch);
    }
    return r;
  }

  /** A new job for this customer. → the new job id. */
  async function add(lead, fields) {
    const w = root;
    const id = 'j' + Date.now().toString(36);
    const job = Object.assign({
      stage: 'new', stageRole: 'new', title: 'Job',
      property: { address: lead.address || '', lat: Number.isFinite(lead.lat) ? lead.lat : null, lng: Number.isFinite(lead.lng) ? lead.lng : null },
    }, fields || {}, {
      createdAt: w.serverTimestamp(), origin: 'add_job',
    });
    // Stamps must equal the lead's (jobWriteOk): copy only the ones it HAS.
    // A null companyId on a solo owner's lead reads as '' in the rules, and
    // null != '' would deny the create.
    if (lead.userId) job.userId = lead.userId;
    if (lead.companyId) job.companyId = lead.companyId;
    await w.setDoc(w.doc(w.db, 'leads', lead.id, 'jobs', id), job);
    const arr = byLead.get(lead.id) || [];
    arr.push(Object.assign({ id }, job, { createdAt: Date.now() }));
    byLead.set(lead.id, arr);
    return id;
  }

  const api = { JOB_FIELDS, isOpen, cardsFor, routeFor, records, recordsFor, load, loadLead, forLead, update, add, loadedAt: () => loadedAt };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDJobs = api;
})(typeof window !== 'undefined' ? window : null);
