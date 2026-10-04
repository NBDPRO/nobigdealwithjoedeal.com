// @ts-check
// tests/e2e/fixtures/seeded-run.js — delete what ONE spec run seeded, by tag.
//
// 2026-09-25, phone-audit follow-up (documentation/qa/phone-audit-2026-09-25.md
// → Follow-ups §7): phone-chrome seeded a lead, an estimate and two photos in
// each describe and never removed them, and phone-dashnav leaked its lead
// whenever beforeAll timed out, because the id it deleted by was never
// returned. Every later spec in the same emulator shard then saw those
// records (lists sort newest-first, so "the first estimate" became ours).
//
// The fix has two halves:
//   1. A spec stamps every doc it seeds with e2eTestData:true (what the
//      cleanupE2ETestData callable sweeps, on a rig that runs functions) and
//      an e2eRun tag unique to this run of this describe. The tag is set
//      BEFORE the first write, so it is known even if the hook dies.
//   2. Its afterAll calls deleteSeededRun(), which finds the docs BY TAG,
//      never by ids held in test variables — so a hook that timed out after
//      its writes still gets cleaned.
//
// Scope is userId == the signed-in user AND e2eRun == this run. Never wider:
// the shared local rig runs several lanes on the ONE test user at once, and a
// sweep of every e2eTestData doc would delete another lane's seeds mid-run.
// The test user owns every doc it seeded, so the owner-delete rules allow it
// from the client — no Cloud Function needed (the audit shard runs none).
//
// One known remainder: rows the APP files under leads/{id}/documents (the
// customer report the doc viewer saves) cannot be deleted from a client.
// documentStatusWriteOk() in firestore.rules reads request.resource, which
// is null on a delete, so the rule errors and denies (checked on the
// emulator 2026-09-25: 403 for the lead's owner; no client code deletes
// these rows today). They stay orphaned under the deleted lead, where no
// client query reaches them; the cleanupE2ETestData callable removes them on
// a rig that runs functions.
const { loginAs, safeEvaluate } = require('./auth');

// Top-level collections a seeded doc can land in. Leads are handled
// separately: their tasks subcollection goes first, because the task rule
// reads the parent lead and would deny once the lead is gone.
const FLAT = ['estimates', 'photos'];

/**
 * Where a seed is written, wrap it so a later cleanup can wait for it:
 * `window.__e2eSeeding = (async () => { ... })()`. The sweep waits (up to
 * 15s) for that promise, then (up to 10s more) for every write the Firestore
 * SDK still holds unacknowledged, before it looks anything up. A beforeAll
 * that timed out mid-seed leaves the seed running. And on a stalled rig
 * (2026-09-25) a seed's read-back found no lead and returned null, the sweep
 * found nothing either, and the tagged lead was in the emulator afterwards:
 * a write still in flight when both looked.
 *
 * Lookups go to the server (getDocsFromServer), never the cache: a stalled
 * emulator would otherwise hand back a partial list, and the sweep would
 * report a clean result. A stalled rig also puts the SDK "offline" for a
 * while — getDocsFromServer then fails at once, and one lookup that waited
 * 10s left its estimate behind (both seen 2026-09-25). So every lookup is
 * retried, one try at most 10s, until a 45s budget runs out. Deletes are
 * queued in issue order (tasks before their lead; the SDK commits in that
 * order) and awaited together within what is left of the budget. A dead rig
 * shows up as `failed` entries, never a hung afterAll.
 *
 * @param {import('@playwright/test').Page} page — the page that seeded
 * @param {string} run — the e2eRun tag stamped on every seeded doc
 */
function sweep(page, run) {
  return safeEvaluate(page, async ({ tag, flat }) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const within = (ms, p) => new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no answer in ${Math.round(ms)}ms`)), ms);
      Promise.resolve(p).then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
    if (window.__e2eSeeding) await Promise.race([Promise.resolve(window.__e2eSeeding).catch(() => {}), sleep(15_000)]);
    // A page mid-navigation (customer.html still booting) exposes db/auth late.
    for (let i = 0; i < 40 && !(window.db && window.auth && window.auth.currentUser); i++) await sleep(250);
    if (!(window.db && window.auth && window.auth.currentUser)) return { signedIn: false, deleted: [], failed: [] };
    const fs = await import('/assets/vendor/firebase/12.19.0/firebase-firestore.js');
    const db = window.db;
    const uid = window.auth.currentUser.uid;
    await Promise.race([fs.waitForPendingWrites(db).catch(() => {}), sleep(10_000)]);
    const deadline = Date.now() + 45_000;
    const deleted = [];
    const failed = [];
    const fromServer = async (q) => {
      let last = null;
      while (Date.now() < deadline) {
        try { return await within(Math.min(10_000, deadline - Date.now()), fs.getDocsFromServer(q)); }
        catch (e) { last = e; await sleep(1_000); }
      }
      throw last || new Error('out of time');
    };
    const tagged = (coll) => fromServer(fs.query(fs.collection(db, coll),
      fs.where('userId', '==', uid), fs.where('e2eTestData', '==', true), fs.where('e2eRun', '==', tag)));
    const queued = [];
    const del = (ref) => queued.push(fs.deleteDoc(ref).then(
      () => { deleted.push(ref.path); },
      (e) => { failed.push(ref.path + ': ' + (e && e.message)); }));
    for (const coll of flat) {
      try { for (const d of (await tagged(coll)).docs) del(d.ref); } catch (e) { failed.push(coll + ' lookup: ' + (e && e.message)); }
    }
    try {
      for (const lead of (await tagged('leads')).docs) {
        for (const t of (await fromServer(fs.collection(db, 'leads', lead.id, 'tasks'))).docs) del(t.ref);
        del(lead.ref);
      }
    } catch (e) { failed.push('leads lookup: ' + (e && e.message)); }
    try { await within(Math.max(1_000, deadline - Date.now()), Promise.all(queued)); }
    catch (e) { failed.push(`deletes unacknowledged (${deleted.length}/${queued.length} landed): ${e && e.message}`); }
    return { signedIn: true, deleted, failed };
  }, { tag: run, flat: FLAT });
}

/**
 * Delete every doc tagged `e2eRun: run` that the signed-in test user owns:
 * FLAT collections, then each tagged lead's tasks, then the lead. Runs on the
 * spec's own page; if that page is closed or its evaluate throws (crashed,
 * wedged), retries once on a fresh page in the same context after a login.
 * A page that simply never signed in seeded nothing, so it is not retried.
 * Never throws: an afterAll must still close its context.
 *
 * @param {{ page?: import('@playwright/test').Page, context?: import('@playwright/test').BrowserContext,
 *           creds?: { email: string, password: string } | null, run?: string }} opts
 * @returns {Promise<{ signedIn: boolean, deleted: string[], failed: string[] }>}
 */
async function deleteSeededRun({ page, context, creds, run }) {
  const none = { signedIn: false, deleted: [], failed: [] };
  if (!run) return none;
  let firstError = '';
  if (page && !page.isClosed()) {
    try { return await sweep(page, run); } catch (e) { firstError = String((e && e.message) || e).split('\n')[0]; }
  }
  if (!context || !creds) return firstError ? { ...none, failed: ['sweep: ' + firstError] } : none;
  let fresh = null;
  try {
    fresh = await context.newPage();
    await loginAs(fresh, creds);
    return await sweep(fresh, run);
  } catch (e) {
    return { ...none, failed: [firstError && 'sweep: ' + firstError, 'retry on a fresh page: ' + String((e && e.message) || e).split('\n')[0]].filter(Boolean) };
  } finally {
    if (fresh) await fresh.close().catch(() => {});
  }
}

module.exports = { deleteSeededRun };
