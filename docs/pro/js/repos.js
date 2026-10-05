/**
 * repos.js — Firestore repository layer.
 *
 * Centralizes every write to /leads, /photos, /estimates so that
 * userId, companyId, createdAt, updatedAt are stamped exactly once
 * and exactly the same way at every call site. Eliminates the class
 * of bugs where a new code path forgets to set companyId (which
 * firestore.rules now requires for /leads/{id} create — see PR #60)
 * or stamps the wrong server timestamp.
 *
 * Auth + tenant context comes from the live globals the existing
 * pages already populate:
 *   - window.auth.currentUser.uid     — owner uid
 *   - window._userClaims.companyId    — tenant id from custom claims
 *   - window.serverTimestamp()        — Firestore SDK helper
 *
 * Use:
 *
 *   const docRef = await window.NBDRepos.leads.create({
 *     fullName: 'Joe Customer',
 *     address: '123 Main',
 *     stage: 'NEW_LEAD',
 *   });
 *   await window.NBDRepos.leads.update(leadId, { stage: 'INSPECTED' });
 *   await window.NBDRepos.photos.create({ leadId, url, phase: 'Before' });
 *
 * The repos do NOT replace direct Firestore SDK use — they're a
 * thin convention layer. Reads still go through getDoc/getDocs
 * directly. New code should prefer the repos for writes; existing
 * call sites can migrate at their own pace.
 *
 * @typedef {import('./types.js').Lead}     Lead
 * @typedef {import('./types.js').Photo}    Photo
 * @typedef {import('./types.js').Estimate} Estimate
 */
(function () {
  'use strict';

  if (window.NBDRepos && window.NBDRepos.__sentinel === 'nbd-repos-v1') return;

  /**
   * Resolve the current authenticated uid + companyId. Throws a
   * specific error if either is missing — fail fast on call sites
   * that try to write while signed out, rather than silently writing
   * a doc that violates firestore.rules.
   *
   * @returns {{ uid: string, companyId: string }}
   */
  function context() {
    var uid = window.auth && window.auth.currentUser && window.auth.currentUser.uid;
    if (!uid) {
      var err = new Error('NBDRepos: no signed-in user');
      err.code = 'unauthenticated';
      throw err;
    }
    // Audit batch 6 (2026-05-13): solo operators don't carry a separate
    // companyId on their custom claims — the convention across the codebase
    // (dashboard.html lead-create at line 2472, functions/index.js line 283)
    // is `companyId || uid`. Repos.js was originally stricter but never
    // adopted because of that. Aligned now: solo operator gets their own
    // uid as the companyId. Multi-rep companies still get the real claim.
    var companyId = (window._userClaims && window._userClaims.companyId)
                 || (window._user && window._user.companyId)
                 || uid;
    return { uid: uid, companyId: companyId };
  }

  /**
   * Stamp the four "every doc gets this" fields exactly once.
   * Existing values in `data` win — this is a fill-defaults pass,
   * not an overwrite. Lets the rare call site that NEEDS to override
   * (e.g. backfill scripts) still do so.
   *
   * @param {object} data
   * @returns {object}
   */
  function stampCreate(data) {
    var ctx = context();
    var st = window.serverTimestamp ? window.serverTimestamp() : new Date().toISOString();
    return Object.assign({
      userId:    ctx.uid,
      companyId: ctx.companyId,
      createdAt: st,
      updatedAt: st,
      // Server lead meter (2026-10-04): firestore.rules require it on every
      // client lead create; functions/lead-cap.js counts it. A caller may
      // pass its own ('import' / 'sample').
      meter:     'manual',
    }, data);
  }

  /**
   * Update-time stamp. updatedAt is forced — it's a server-managed
   * field and call sites should never set it manually.
   *
   * @param {object} data
   * @returns {object}
   */
  function stampUpdate(data) {
    var st = window.serverTimestamp ? window.serverTimestamp() : new Date().toISOString();
    return Object.assign({}, data, { updatedAt: st });
  }

  // Every soft delete records WHEN (2026-10-03 data audit: 10 deleted leads
  // had no deletedAt, so the Deleted bin could not age or sort them). Same
  // pair the dashboard's own delete writes (_deleteLead).
  function stampSoftDelete() {
    var st = window.serverTimestamp ? window.serverTimestamp() : new Date().toISOString();
    return stampUpdate({ deleted: true, deletedAt: st });
  }

  // ── /leads ─────────────────────────────────────────────────────
  var leads = {
    /**
     * Create a new lead. companyId + userId + timestamps stamped
     * automatically. Caller passes only domain fields.
     *
     * @param {Partial<Lead>} data
     * @returns {Promise<{id: string}>}
     */
    create: async function (data) {
      var ref = await window.addDoc(
        window.collection(window.db, 'leads'),
        stampCreate(data)
      );
      return { id: ref.id };
    },

    /**
     * Update an existing lead. Caller cannot accidentally bump
     * userId / companyId / createdAt — those four are not in the
     * stampUpdate output.
     *
     * @param {string} id
     * @param {Partial<Lead>} data
     */
    update: async function (id, data) {
      return window.updateDoc(window.doc(window.db, 'leads', id), stampUpdate(data));
    },

    /**
     * Soft-delete (sets `deleted: true` rather than removing the doc),
     * because /estimates and /photos hold leadId references and a
     * hard delete would orphan them. The dashboard "deleted" drawer
     * surfaces these for restore.
     *
     * @param {string} id
     */
    softDelete: async function (id) {
      return window.updateDoc(window.doc(window.db, 'leads', id), stampSoftDelete());
    },

    /**
     * Hard-delete — only call from a confirmed-destructive UI path
     * after the lead is already soft-deleted. Cascading cleanup of
     * /photos and /estimates owned by this lead must be done in a
     * Cloud Function (admin SDK) — clients can't bulk-delete across
     * collections under firestore.rules.
     *
     * @param {string} id
     */
    hardDelete: async function (id) {
      return window.deleteDoc(window.doc(window.db, 'leads', id));
    },
  };

  // ── /photos ────────────────────────────────────────────────────
  var photos = {
    /**
     * Create a new photo. companyId + userId + timestamps stamped
     * automatically. `leadId` is required and not enforced here —
     * firestore.rules will reject writes without it.
     *
     * @param {Partial<Photo> & {leadId: string, url: string}} data
     * @returns {Promise<{id: string}>}
     */
    create: async function (data) {
      var ref = await window.addDoc(
        window.collection(window.db, 'photos'),
        stampCreate(Object.assign({
          phase:    'During',
          category: 'Property',
        }, data))
      );
      return { id: ref.id };
    },

    /**
     * @param {string} id
     * @param {Partial<Photo>} data
     */
    update: async function (id, data) {
      return window.updateDoc(window.doc(window.db, 'photos', id), stampUpdate(data));
    },

    /**
     * @param {string} id
     */
    delete: async function (id) {
      return window.deleteDoc(window.doc(window.db, 'photos', id));
    },

    /**
     * Bulk-update (e.g. multi-select set-phase from PR #65). One
     * writeBatch round-trip for the whole array — atomic across all
     * docs.
     *
     * @param {Array<string>} ids
     * @param {Partial<Photo>} patch
     */
    bulkUpdate: async function (ids, patch) {
      if (!ids || !ids.length) return;
      var batch = window.writeBatch(window.db);
      var stamped = stampUpdate(patch);
      for (var i = 0; i < ids.length; i++) {
        batch.update(window.doc(window.db, 'photos', ids[i]), stamped);
      }
      return batch.commit();
    },

    /**
     * Bulk-delete via writeBatch (companion to bulkUpdate).
     * @param {Array<string>} ids
     */
    bulkDelete: async function (ids) {
      if (!ids || !ids.length) return;
      var batch = window.writeBatch(window.db);
      for (var i = 0; i < ids.length; i++) {
        batch.delete(window.doc(window.db, 'photos', ids[i]));
      }
      return batch.commit();
    },
  };

  // ── /estimates ─────────────────────────────────────────────────
  var estimates = {
    /**
     * @param {Partial<Estimate> & {leadId: string}} data
     * @returns {Promise<{id: string}>}
     */
    create: async function (data) {
      var ref = await window.addDoc(
        window.collection(window.db, 'estimates'),
        stampCreate(data)
      );
      return { id: ref.id };
    },

    /**
     * @param {string} id
     * @param {Partial<Estimate>} data
     */
    update: async function (id, data) {
      return window.updateDoc(window.doc(window.db, 'estimates', id), stampUpdate(data));
    },

    /**
     * Soft-delete — same rationale as leads.softDelete: shared
     * documents and downstream reports may reference the estimate
     * id.
     *
     * @param {string} id
     */
    softDelete: async function (id) {
      return window.updateDoc(
        window.doc(window.db, 'estimates', id),
        stampSoftDelete()
      );
    },
  };

  window.NBDRepos = {
    __sentinel: 'nbd-repos-v1',
    leads:     leads,
    photos:    photos,
    estimates: estimates,
    // Surfaced for tests + advanced call sites that need to compose
    // their own writeBatch with the same stamping convention.
    _stampCreate: stampCreate,
    _stampUpdate: stampUpdate,
    _context:     context,
  };
})();
