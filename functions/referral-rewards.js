/**
 * functions/referral-rewards.js — referral-CODE redemption + $100 bonus.
 * ═══════════════════════════════════════════════════════════════
 *
 * The redemption/crediting half of the "share your code" lane. A past
 * customer is texted a personal referral code (JOHN-AB12) by
 * review-engine.js `sendReferralSMS`, promising them a $100 bonus "when
 * their project closes." This trigger is what makes that promise real.
 *
 * A referred lead is stamped with `redeemReferralCode` at intake — either
 * by the rep in the Add/Edit Lead modal (docs/pro/js/crm-leads.js) or by a
 * friend on the public intake form (functions/handlers/integrations.js
 * `submitPublicLead` → lead-bridge). This single `leads/{leadId}` onWrite
 * trigger then does everything server-side (no client is trusted in the
 * money path):
 *
 *   Phase A — ATTRIBUTE: resolve the code against the `referrals` collection
 *     (minted by review-engine.js `assignReferralCode`), validate it belongs
 *     to the same rep/tenant and isn't a self-referral, and link the referred
 *     lead back to the referrer (referrerLeadId + referralRewardStatus:
 *     'pending'). Idempotent via the `referralAttributedAt` latch.
 *
 *   Phase B — CREDIT: when the referred lead's project reaches a CLOSED stage
 *     (Jo's chosen payout moment), record the $100 as OWED on the referrer's
 *     referrals doc and notify the rep to pay it. Idempotent via the
 *     referralRewardStatus pending→owed flip. There is no automated payment
 *     rail to a customer — the bonus is TRACKED + the rep is notified; they
 *     pay it manually and mark it settled.
 *
 * Distinct from the working customerId LINK lane (functions/referrals.js
 * `submitReferral`), which stamps `referredByLeadId` and deliberately makes
 * NO payout promise. Only code-lane leads (they carry `referralRewardStatus`)
 * are credited here.
 *
 * NOTE the export below is a LITERAL `exports.x = onDocumentWritten(...)`
 * call — the CI auto-deploy allowlist greps that exact shape
 * (.github/workflows/firebase-deploy.yml). A wrapper RHS would be silently
 * dropped from the deploy (same gap documented in lead-bridge.js).
 */

'use strict';

const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { logger } = require('firebase-functions/v2');
// Modular FieldValue/getFirestore — FieldValue is undefined under the
// namespaced admin import in the emulator runtime; the modular path works in
// both prod and emulator (see lead-bridge.js / emulator-QA notes).
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

// The bonus a referrer earns when a lead they referred via their personal
// code reaches a closed project. Single source of truth so this payout and
// the SMS copy (docs/pro/js/review-engine.js) stay in sync. FUTURE: read
// per-tenant from companyProfile so each SaaS tenant sets their own amount;
// hardcoded for now.
// $100 everywhere — all states, all job types (Jo, 2026-09-27; was $200).
const REFERRAL_BONUS_USD = 100;

// Stages that count as "the project closed" — Jo's payout trigger. Matches
// crm-stages.js S.CLOSED ('closed', the 🏆 final job stage) plus the legacy
// display names that normalize to it. Compared after lower-casing +
// space→underscore so 'Closed', 'Closed Won' and 'Complete' all match.
const CLOSED_STAGES = new Set(['closed', 'closed_won', 'closed-won', 'complete']);

function normStage(s) {
  return String(s || '').toLowerCase().trim().replace(/\s+/g, '_');
}
function isClosed(stage) {
  return CLOSED_STAGES.has(normStage(stage));
}
// Freeform-pipeline aware (Phase 3): the payout fires when the referred lead's
// project reaches a WON-role stage — including a tenant's CUSTOM won stage,
// resolved from the persisted lead.stageRole. Built-in stages keep working via
// the CLOSED_STAGES fallback below.
const { isWon: _roleIsWon } = require('./stage-roles');
function projectClosed(lead) {
  return _roleIsWon(lead) || isClosed(lead && lead.stage);
}
function fullName(lead) {
  return `${(lead && lead.firstName) || ''} ${(lead && lead.lastName) || ''}`.trim();
}

async function handleReferralLeadWrite(event) {
  const afterSnap = event.data && event.data.after;
  const after = afterSnap && afterSnap.exists ? afterSnap.data() : null;
  if (!after) return; // lead deleted — nothing to do
  const before = event.data && event.data.before && event.data.before.exists
    ? event.data.before.data() : null;
  const leadId = event.params && event.params.leadId;
  const db = getFirestore();

  // ─── Phase A: attribute a freshly-entered referral code ─────────
  // The referred lead carries `redeemReferralCode` (rep- or public-stamped).
  // `referralAttributedAt` is a process-once latch, but it is set on the INVALID
  // path too — so gating on it ALONE traps a corrected code forever. Re-run Phase
  // A when the code is newly present OR was CHANGED (a rep fixing a typo, or
  // switching referrer). Never re-open once a bonus is actually owed/paid: that
  // credit stands.
  const beforeCode = before && before.redeemReferralCode
    ? String(before.redeemReferralCode).toUpperCase().trim() : '';
  const afterCode = after.redeemReferralCode
    ? String(after.redeemReferralCode).toUpperCase().trim() : '';
  const codeChanged = !!afterCode && afterCode !== beforeCode;
  const alreadyRewarded = after.referralRewardStatus === 'owed'
    || after.referralRewardStatus === 'paid';
  if (afterCode && !alreadyRewarded && (!after.referralAttributedAt || codeChanged)) {
    const code = afterCode;

    // Mark the code processed-but-not-credited (unknown / foreign / self /
    // empty). We still set the latch so the trigger stops re-evaluating an
    // UNCHANGED bad code — a corrected code re-opens Phase A via the gate above.
    // Also notify the rep so a fat-fingered code is a visible, fixable failure
    // rather than a silent one (the customer was SMS-promised the bonus).
    const markInvalid = async (reason) => {
      logger.info('[referral] code not attributed', { leadId, code, reason });
      try {
        await afterSnap.ref.set({
          referralAttributedAt: FieldValue.serverTimestamp(),
          referralCodeInvalid: true,
        }, { merge: true });
      } catch (e) {
        logger.error('[referral] invalid-latch write failed', { leadId, err: e && e.message });
      }
      try {
        await db.collection('notifications').add({
          userId: after.userId || null,
          type: 'referral',
          leadId,
          title: '⚠️ Referral code not applied',
          message: `Referral code "${code}" on ${fullName(after) || 'a lead'} could not be attributed (${reason}). Check the code and re-enter it to credit the referrer.`,
          read: false,
          dismissed: false,
          createdAt: FieldValue.serverTimestamp(),
        });
      } catch (e) {
        logger.warn('[referral] invalid-notification failed', { leadId, err: e && e.message });
      }
    };

    if (!code) { await markInvalid('empty-code'); return; }

    // Owner not yet resolved (e.g. a public lead mid-bridge). Defer WITHOUT
    // latching so a later write that carries userId can still attribute — and
    // never attribute a code without a resolved owner (closes the null-userId
    // hole where the same-tenant guard below would otherwise fail open).
    if (!after.userId) {
      logger.info('[referral] owner unresolved — deferring attribution', { leadId, code });
      return;
    }

    let snap;
    try {
      snap = await db.collection('referrals').where('code', '==', code).limit(10).get();
    } catch (e) {
      // Transient lookup error — do NOT set the latch, let a later write retry.
      logger.error('[referral] code lookup failed', { leadId, code, err: e && e.message });
      return;
    }
    if (snap.empty) { await markInvalid('unknown-code'); return; }

    // A code SHOULD be unique per mint, but until mint-time uniqueness fully
    // backfills, pick the doc belonging to THIS lead's tenant so a cross-tenant
    // collision can't shadow the right referrer (the old .limit(1) returned an
    // arbitrary match). Prefer companyId, fall back to userId, else first.
    const sameTenantDoc = (d) => {
      const r = d.data() || {};
      if (r.companyId && after.companyId) return r.companyId === after.companyId;
      if (r.userId && after.userId) return r.userId === after.userId;
      return false;
    };
    const refDoc = snap.docs.find(sameTenantDoc) || snap.docs[0];
    const referral = refDoc.data() || {};

    // Guard 1: the code must belong to the SAME TENANT as this lead. Compare
    // companyId when both sides carry it — a code is minted by any rep on the
    // team, but the redeeming lead's userId is whoever entered it (a teammate)
    // or, for a public-microsite lead, the company OWNER. Keying on the minting
    // rep's userId (the old check) wrongly rejected both cases and silently
    // dropped the customer's $100. Fall back to userId only for legacy referrals
    // docs minted before companyId was stamped; both absent = legacy solo tenant.
    let tenantMismatch = false;
    if (referral.companyId && after.companyId) {
      tenantMismatch = referral.companyId !== after.companyId;
    } else if (referral.userId && after.userId) {
      tenantMismatch = referral.userId !== after.userId;
    }
    if (tenantMismatch) { await markInvalid('foreign-tenant-code'); return; }
    // Guard 2: no self-referral — the referrer's own lead can't redeem their
    // own code.
    if (referral.referrerLeadId && referral.referrerLeadId === leadId) {
      await markInvalid('self-referral'); return;
    }

    // Resolve the referrer's display name for the notification + rep-side badge.
    let referrerName = '';
    if (referral.referrerLeadId) {
      try {
        const rl = await db.doc(`leads/${referral.referrerLeadId}`).get();
        if (rl.exists) referrerName = fullName(rl.data());
      } catch (_) { /* best-effort — name is cosmetic */ }
    }

    try {
      // Stamp attribution on the referred lead. referralRewardStatus:'pending'
      // arms Phase B for when this lead's project closes.
      await afterSnap.ref.set({
        referredBy: code,
        referrerLeadId: referral.referrerLeadId || null,
        referralDocId: refDoc.id,
        referredByName: referrerName || null,
        referralRewardStatus: 'pending',
        referralAttributedAt: FieldValue.serverTimestamp(),
        // Clear a stale invalid flag from an earlier mistyped code now corrected.
        referralCodeInvalid: false,
      }, { merge: true });
      // Link the referred lead into the referrer's code record (mirrors the
      // old client trackReferral this replaces).
      await refDoc.ref.set({
        referredLeads: FieldValue.arrayUnion(leadId),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    } catch (e) {
      // Attribution write failed — leave the latch unset so a retry can
      // re-attempt rather than silently losing the referral.
      logger.error('[referral] attribution write failed', { leadId, code, err: e && e.message });
      return;
    }

    // Notify the rep the referral was tracked (mirrors submitReferral's shape).
    try {
      await db.collection('notifications').add({
        userId: referral.userId || after.userId || null,
        type: 'referral',
        leadId,
        title: '🎁 Referral tracked',
        message: `${fullName(after) || 'A new lead'} was referred${referrerName ? ' by ' + referrerName : ''} (code ${code}). $${REFERRAL_BONUS_USD} bonus is owed when their project closes.`,
        read: false,
        dismissed: false,
        createdAt: FieldValue.serverTimestamp(),
      });
    } catch (e) {
      logger.warn('[referral] tracked-notification failed', { leadId, err: e && e.message });
    }

    // The attribution set() above re-fires this trigger; Phase B is evaluated
    // on that next pass (and every subsequent lead write) until close.
    return;
  }

  // ─── Phase B (multi-job): credit the bonus once per JOB ─────────
  // Jo (J1, 2026-09-30): every won job from a referred customer pays the
  // referrer again. The customer's ACTIVE job closing is seen here (its
  // fields are the lead's); another job closing is seen by
  // onReferralJobWrite. The latch is on the job doc (creditJob), so re-fires
  // and our own writes never double-credit.
  const activeJobId = validJobId(after.activeJobId);
  if (activeJobId && REFERRED.has(after.referralRewardStatus) && projectClosed(after)) {
    const wasClosed = !!before && projectClosed(before) && before.activeJobId === after.activeJobId;
    // Cheap gate: a closed lead is re-written often; only look when it JUST
    // closed, the active job changed, or the code was just attributed.
    if (!wasClosed || after.referralRewardStatus === 'pending') {
      await creditJob(db, leadId, after, activeJobId);
    }
    return;
  }

  // ─── Phase B (legacy, no jobs yet): credit the bonus when the referred project closes ─
  // Runs at most once per lead: referralRewardStatus flips pending→owed, so
  // the re-trigger from our own write no longer matches. The status latch —
  // not a stage-transition check — is the idempotency guard, so a code
  // entered on an already-closed lead still credits exactly once.
  if (!activeJobId && after.referralRewardStatus === 'pending' && projectClosed(after)) {
    const amount = REFERRAL_BONUS_USD;
    try {
      await afterSnap.ref.set({
        referralRewardStatus: 'owed',
        referralRewardAmount: amount,
        referralRewardOwedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    } catch (e) {
      logger.error('[referral] reward-status write failed', { leadId, err: e && e.message });
      return; // status still 'pending' — a later write retries
    }

    // Record the owed reward on the referrer's code record. serverTimestamp()
    // is NOT allowed inside arrayUnion(), so the array element carries a
    // concrete Date (admin SDK stores it as a Timestamp).
    if (after.referralDocId) {
      try {
        // Re-verify the referral doc is same-tenant before crediting its ledger.
        // referralDocId is admin-set in Phase A, but defend against a forged /
        // mismatched value pointing at another tenant's referrals doc.
        const rdocSnap = await db.doc(`referrals/${after.referralDocId}`).get();
        const rdoc = rdocSnap.exists ? (rdocSnap.data() || {}) : null;
        const sameTenant = rdoc && (
          (rdoc.companyId && after.companyId) ? rdoc.companyId === after.companyId
            : (rdoc.userId && after.userId) ? rdoc.userId === after.userId
              : true
        );
        if (rdoc && sameTenant) {
          await rdocSnap.ref.set({
            rewards: FieldValue.arrayUnion({
              referredLeadId: leadId,
              amount,
              status: 'owed',
              owedAt: new Date(),
            }),
            rewardsOwedTotal: FieldValue.increment(amount),
            updatedAt: FieldValue.serverTimestamp(),
          }, { merge: true });
        } else {
          logger.warn('[referral] skipped ledger credit — referralDocId missing/foreign', { leadId, referralDocId: after.referralDocId });
        }
      } catch (e) {
        logger.warn('[referral] referral-doc reward update failed', { leadId, err: e && e.message });
      }
    }

    // Notify the rep the bonus is now owed. Recipient is the lead owner, which
    // Phase A validated equals the code's minting rep.
    try {
      await db.collection('notifications').add({
        userId: after.userId || null,
        type: 'referral_reward',
        leadId,
        title: '🎁 Referral bonus owed',
        message: `$${amount} referral bonus owed to ${after.referredByName || 'your referrer'} — ${fullName(after) || 'a referred lead'}'s project closed. Mark paid once you've sent it.`,
        read: false,
        dismissed: false,
        createdAt: FieldValue.serverTimestamp(),
      });
    } catch (e) {
      logger.warn('[referral] reward-notification failed', { leadId, err: e && e.message });
    }
  }
}

// ─── Multi-job: one bonus per won job (Jo, J1, 2026-09-30) ──────────
// A lead that was attributed to a valid code (Phase A) carries one of these.
const REFERRED = new Set(['pending', 'owed', 'paid']);
const FIRST_JOB_ID = 'j1';
const validJobId = (v) => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(v) ? v : null);

/**
 * PURE. What crediting `jobId` does, given the lead and the job doc:
 *   { skip: 'already' }       this job already earned its bonus
 *   { skip: 'legacy', latch } the customer's FIRST job was paid under the old
 *                             once-per-customer rule (before jobs): latch it
 *                             so it never pays twice
 *   { credit: { job, lead } } the job-doc latch + the customer's new balance:
 *                             a still-unpaid bonus grows by one bonus; a paid
 *                             one starts a new owed amount (the Referrals
 *                             "Mark Paid" flow stays per customer)
 */
function planJobCredit(lead, jobId, job, amount) {
  const l = lead || {}, j = job || {};
  if (j.referralRewardOwedAt) return { skip: 'already' };
  if (jobId === FIRST_JOB_ID && l.referralRewardOwedAt && !l.referralRewardJobCount) {
    return { skip: 'legacy', latch: { referralRewardOwedAt: l.referralRewardOwedAt, referralRewardAmount: Number(l.referralRewardAmount) || amount, referralRewardLegacy: true } };
  }
  const owedNow = l.referralRewardStatus === 'owed' ? (Number(l.referralRewardAmount) || amount) : 0;
  return {
    credit: {
      job: { referralRewardAmount: amount },
      lead: { referralRewardStatus: 'owed', referralRewardAmount: owedNow + amount },
    },
  };
}

/** Credit one job's bonus (transactional latch on the job doc), then ledger + bell. */
async function creditJob(db, leadId, lead, jobId) {
  const amount = REFERRAL_BONUS_USD;
  const leadRef = db.collection('leads').doc(String(leadId));
  const jobRef = leadRef.collection('jobs').doc(String(jobId));
  let plan;
  try {
    plan = await db.runTransaction(async (tx) => {
      const [ls, js] = await Promise.all([tx.get(leadRef), tx.get(jobRef)]);
      if (!ls.exists || !js.exists) return { skip: 'missing' };
      const p = planJobCredit(ls.data(), jobId, js.data(), amount);
      if (p.skip === 'legacy') tx.update(jobRef, p.latch);
      if (p.credit) {
        tx.update(jobRef, Object.assign({ referralRewardOwedAt: FieldValue.serverTimestamp() }, p.credit.job));
        tx.update(leadRef, Object.assign({
          referralRewardOwedAt: FieldValue.serverTimestamp(),
          referralRewardJobCount: FieldValue.increment(1),
        }, p.credit.lead));
      }
      return p;
    });
  } catch (e) {
    logger.error('[referral] job credit failed', { leadId, jobId, err: e && e.message });
    return { skip: 'error' };
  }
  if (!plan.credit) return plan;

  if (lead.referralDocId) {
    try {
      const rdocSnap = await db.doc(`referrals/${lead.referralDocId}`).get();
      const rdoc = rdocSnap.exists ? (rdocSnap.data() || {}) : null;
      const sameTenant = rdoc && (
        (rdoc.companyId && lead.companyId) ? rdoc.companyId === lead.companyId
          : (rdoc.userId && lead.userId) ? rdoc.userId === lead.userId
            : true
      );
      if (rdoc && sameTenant) {
        await rdocSnap.ref.set({
          rewards: FieldValue.arrayUnion({ referredLeadId: String(leadId), jobId: String(jobId), amount, status: 'owed', owedAt: new Date() }),
          rewardsOwedTotal: FieldValue.increment(amount),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      } else {
        logger.warn('[referral] skipped ledger credit — referralDocId missing/foreign', { leadId, jobId, referralDocId: lead.referralDocId });
      }
    } catch (e) {
      logger.warn('[referral] referral-doc reward update failed', { leadId, jobId, err: e && e.message });
    }
  }
  try {
    await db.collection('notifications').add({
      userId: lead.userId || null,
      type: 'referral_reward',
      leadId: String(leadId),
      title: '🎁 Referral bonus owed',
      message: `$${amount} referral bonus owed to ${lead.referredByName || 'your referrer'} — a job for ${fullName(lead) || 'a referred customer'} closed. Mark paid once you've sent it.`,
      read: false,
      dismissed: false,
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (e) {
    logger.warn('[referral] reward-notification failed', { leadId, jobId, err: e && e.message });
  }
  return plan;
}

/** A job other than the customer's active one closed → its bonus. */
async function handleReferralJobWrite(event) {
  const after = event.data && event.data.after && event.data.after.exists ? event.data.after.data() : null;
  if (!after || after.referralRewardOwedAt || !projectClosed(after)) return;
  const { leadId, jobId } = event.params || {};
  if (!validJobId(jobId)) return;
  const db = getFirestore();
  const ls = await db.collection('leads').doc(String(leadId)).get();
  const lead = ls.exists ? ls.data() : null;
  if (!lead || !REFERRED.has(lead.referralRewardStatus)) return;   // not a referred customer
  if (lead.activeJobId === jobId) return;                          // the lead path handles it
  await creditJob(db, leadId, lead, jobId);
}

exports.onReferralJobWrite = onDocumentWritten(
  {
    region: 'us-central1',
    document: 'leads/{leadId}/jobs/{jobId}',
    memory: '256MiB',
    timeoutSeconds: 60,
    maxInstances: 20,
  },
  handleReferralJobWrite
);

exports._internal = { planJobCredit, creditJob, handleReferralJobWrite, handleReferralLeadWrite, REFERRAL_BONUS_USD };

exports.onReferralLeadWrite = onDocumentWritten(
  {
    region: 'us-central1',
    document: 'leads/{leadId}',
    memory: '256MiB',
    timeoutSeconds: 60,
    maxInstances: 20,
  },
  handleReferralLeadWrite
);
