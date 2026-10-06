/**
 * Photo queue boot recovery.
 *
 * Persisting the offline photo queue (photo-queue-store.js) is only half a
 * fix. photo-engine.js is lazy-loaded — it arrives with ScriptLoader's
 * `photos` bundle, which loads when the rep opens a photos view. So a photo
 * that survives the reload still uploads nothing until the rep happens to
 * navigate back to photos. On a roof, after a bfcache resume, that is not a
 * safe assumption to build a promise on.
 *
 * This module closes the loop: on every dashboard boot, if the durable queue
 * has rows, it waits for Firebase auth, pulls in the photos bundle, and asks
 * PhotoEngine to drain. The rep does nothing.
 *
 * It is deliberately separate from photo-queue-store.js so that the store
 * stays a pure, side-effect-free storage module that a unit test can drive
 * without a DOM, a ScriptLoader, or a Firebase.
 *
 * SECOND JOB: be the witness that outlives the browser.
 *
 * The store's detectLoss() spots an eviction by finding its localStorage
 * counter alive next to an empty object store. That works for a partial
 * eviction and cannot work for the one the file's own comments kept naming:
 * WebKit's 7-day ITP purge (and "Clear History and Website Data") deletes
 * every script-writable store this origin owns in ONE operation, so the
 * counter dies with the photos and detectLoss() has nothing to compare —
 * it returned 0 and the rep was told nothing at all. Nothing kept on the
 * device can survive that; the only witness that can is the server.
 *
 * So while there are photos held, this module mirrors the pending count to
 * userSettings/{uid} (already owner-read/write in firestore.rules), and when
 * it boots to find the local counter GONE it asks the server whether photos
 * were owed. The marker is written only by a device that has its own local
 * counter — a second device must never clear the record of photos still
 * sitting on the first one.
 *
 * THIRD JOB: keep the local counter alive, because we delete it ourselves.
 *
 * nbd-auth.js purgeAccountStorage() drops every `nbd_`-prefixed localStorage
 * key outside its KEEP set on EVERY logout and account switch, while the
 * IndexedDB rows sit there untouched. Nothing re-created the counter, so an
 * ordinary sign-out left detectLoss() with no baseline and no way back —
 * blind until the next add() or remove() happened to rewrite it. A rep who
 * signed out on Friday and was evicted on Monday was told nothing.
 *
 * The same gap made the server read above a per-BOOT cost rather than a
 * per-device one: a rep who has never queued a photo has no counter to write,
 * so every dashboard load re-opened IndexedDB, waited for auth and re-read the
 * marker. (An earlier version of this comment claimed otherwise. It was
 * wrong.) Seeding the counter on boot — only ever ESTABLISHING it, never
 * overwriting a real one — closes both.
 */

(function () {
  'use strict';

  if (window.__nbdPhotoQueueRecoveryBound) return;
  window.__nbdPhotoQueueRecoveryBound = true;

  // Firebase auth resolves asynchronously after boot. uploadPhotoToFirebase()
  // throws without _storage/_db/_user, and a throw would re-queue every item
  // and burn a drain cycle, so wait for a real signal instead of racing it.
  const AUTH_POLL_MS = 500;
  const AUTH_TIMEOUT_MS = 60000;

  function firebaseReady() {
    return !!(window._storage && window._db && window._user);
  }

  function waitForFirebase() {
    if (firebaseReady()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (firebaseReady()) { clearInterval(timer); resolve(true); return; }
        if (Date.now() - started > AUTH_TIMEOUT_MS) {
          clearInterval(timer);
          // Not an error: a signed-out rep on the login screen hits this
          // every time. The rows stay in IndexedDB for the next boot.
          resolve(false);
        }
      }, AUTH_POLL_MS);
    });
  }

  function loadPhotoEngine() {
    if (window.PhotoEngine && typeof window.PhotoEngine.flushUploadQueue === 'function') {
      return Promise.resolve(true);
    }
    const loader = window.ScriptLoader;
    if (!loader || typeof loader.loadBundle !== 'function') return Promise.resolve(false);
    return loader.loadBundle('photos')
      .then(() => !!(window.PhotoEngine && typeof window.PhotoEngine.flushUploadQueue === 'function'))
      .catch((e) => {
        console.warn('[PhotoQueueRecovery] photos bundle failed to load:', e && e.message);
        return false;
      });
  }

  function toast(msg, kind) {
    if (typeof window.showToast === 'function') { window.showToast(msg, kind); return; }
    console.log('[PhotoQueueRecovery]', msg);
  }

  // ── the server-side witness ───────────────────────────────────────────────
  // One field on the doc the CRM already keeps per user. No rules change:
  // firestore.rules `match /userSettings/{uid}` is owner read/write.
  const MARKER_COLLECTION = 'userSettings';
  const MARKER_FIELD = 'photoQueuePending';
  const MARKER_AT_FIELD = 'photoQueuePendingAt';
  // Which marker the rep has already been told about. This lives on the
  // SERVER, not in localStorage, because nbd-auth.js purgeAccountStorage()
  // drops every `nbd_`-prefixed key that is not in its KEEP set on every
  // logout and account switch — so a local "already reported" flag is erased
  // by an ordinary sign-out and the rep gets accused a second time.
  const MARKER_ACK_FIELD = 'photoQueueLossAckAt';
  // What we last pushed, so a boot with an unchanged queue writes nothing.
  // Purged on logout too; losing it costs one redundant write, nothing more.
  const MARKER_MIRROR_KEY = 'nbd_photo_queue_marker_synced';

  function lsGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, String(v)); } catch (_) {} }

  /**
   * A notice that STAYS. window.showToast removes itself after 2600 ms
   * (dashboard-ui-prefs-boot.js:44) — on a boot, which is before a rep on a
   * roof has looked at the phone. offline-manager.js:123 already made this
   * call for the strictly lower-stakes JSON queue, with the reason in a
   * comment: "a 3s toast vanishes before a contractor in the field ever
   * notices". Photos are worth at least as much. Distinct id from that
   * banner so the two can coexist.
   * No inline handlers anywhere — CSP here is script-src-attr 'none'.
   */
  function stickyNotice(message) {
    if (typeof document === 'undefined' || !document.body) return false;
    if (document.getElementById('nbd-photo-loss-banner')) return true;
    const banner = document.createElement('div');
    banner.id = 'nbd-photo-loss-banner';
    banner.setAttribute('role', 'alert');
    banner.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0',
      'padding:10px 44px 10px 16px',
      'background:#b91c1c', 'color:#fff',
      'font-size:13px', 'font-weight:600',
      'text-align:center', 'line-height:1.35',
      'z-index:99001', 'box-shadow:0 2px 10px rgba(0,0,0,.35)',
      'padding-top:calc(10px + env(safe-area-inset-top,0px))'
    ].join(';');
    const label = document.createElement('span');
    label.textContent = '⚠ ' + message;
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Dismiss photo upload warning');
    close.style.cssText = 'position:absolute;top:6px;right:8px;background:transparent;'
      + 'border:0;color:#fff;font-size:22px;font-weight:700;cursor:pointer;padding:4px 10px;line-height:1;';
    close.addEventListener('click', function () { banner.remove(); });
    banner.appendChild(label);
    banner.appendChild(close);
    document.body.appendChild(banner);
    return true;
  }

  /**
   * The Firestore handles, or null. Both spellings of the db global are in
   * use across docs/pro/js (see analytics-kpi.js), and the modular v9 helpers
   * are re-exported onto window for the non-module IIFEs like this one.
   */
  function firestore() {
    const db = window._db || window.db;
    const uid = window._user && window._user.uid;
    const doc = window.doc;
    const getDoc = window.getDoc;
    const setDoc = window.setDoc;
    if (!db || !uid) return null;
    if (typeof doc !== 'function' || typeof getDoc !== 'function' || typeof setDoc !== 'function') return null;
    return { ref: doc(db, MARKER_COLLECTION, uid), getDoc: getDoc, setDoc: setDoc };
  }

  /** { held, at, ackAt } from the server, or null when we could not read it. */
  async function readMarker() {
    const fs = firestore();
    if (!fs) return null;
    try {
      const snap = await fs.getDoc(fs.ref);
      const data = (snap && typeof snap.data === 'function' && snap.data()) || null;
      // A doc that does not exist is a real ANSWER — "nothing was owed" — not
      // a failed read. The caller seeds the local counter off the difference,
      // so conflating the two would make every boot re-ask the server.
      if (!data) return { held: 0, at: 0, ackAt: 0 };
      const held = parseInt(data[MARKER_FIELD], 10);
      return {
        held: isNaN(held) ? 0 : held,
        at: data[MARKER_AT_FIELD] || 0,
        ackAt: data[MARKER_ACK_FIELD] || 0
      };
    } catch (e) {
      console.warn('[PhotoQueueRecovery] could not read the queue marker:', e && e.message);
      return null;
    }
  }

  /**
   * Mirror a DEFINITE local count to the server. Called only from a device
   * that has its own localStorage counter: without that guard a second device
   * booting fresh would write 0 over the record of photos still held on the
   * first one, destroying the only evidence they were ever owed.
   */
  // How long any single marker write may hold the queue below. setDoc()'s
  // promise does not settle until the backend acknowledges, so a write made
  // on a dead connection stays pending until connectivity returns. (Written
  // when Firestore ran with no local cache; since 2026-10-04 nbd-auth.js uses
  // a persistent one, so the write now also outlives the page — but the
  // promise still waits for the server, and the bound is still needed.) Without a bound, ONE such write would stall every marker
  // write after it for the life of the page.
  //
  // Read through a window hook, matching photo-engine.js's
  // `__nbdMarkerSyncTimeoutMs`. The behaviour that matters here only appears
  // once a write is ABANDONED by this bound, and a test that had to wait five
  // real seconds to reach it would either be skipped or written to something
  // faster and weaker — which is exactly how the defect this bound now guards
  // reached main: the regression test used a write that never landed at all,
  // so the abandoned-then-landed path was never exercised.
  function markerWriteTimeoutMs() {
    const v = typeof window !== 'undefined' && window.__nbdMarkerWriteTimeoutMs;
    return typeof v === 'number' && v > 0 ? v : 5000;
  }

  // Serialised at the RESOURCE, not at one caller. writeMarker() is a
  // read-modify-write across an await — read the mirror key, compare, await
  // setDoc, write the mirror key — and it has four call sites: the two around
  // the drain in recover(), the floating repair on the empty-queue fast path,
  // and syncMarker() from photo-engine after every drain. Chaining inside one
  // of those callers would leave the other three racing it, so the queue lives
  // here and everything that writes the marker goes through it.
  let _markerChain = Promise.resolve();

  function writeMarker(n) {
    _markerChain = _markerChain
      .then(() => _bounded(_writeMarkerOnce(n), markerWriteTimeoutMs()))
      .catch(() => {});
    return _markerChain;
  }

  /**
   * Settle no later than `ms`, whatever the wrapped promise does.
   *
   * A queue whose links can hang is worse than no queue: one never-settling
   * setDoc would wedge every later marker write, which is strictly worse than
   * the interleaving the queue exists to prevent. Abandoning the wait does not
   * cancel the write — Firestore keeps it buffered and flushes it on reconnect,
   * and writes to one document land in the order they were issued, so a late
   * arrival still lands in the right order relative to the next one.
   *
   * That ordering guarantee covers the SERVER. It did not cover the mirror
   * key, which _writeMarkerOnce used to update only on the ack — so an
   * abandoned write left the mirror behind, and the next link skipped itself
   * as "unchanged" against a value that was already obsolete. The mirror is
   * now recorded at issue time for exactly this reason; see the comment there.
   */
  function _bounded(promise, ms) {
    let timer = null;
    const clear = () => { if (timer !== null) { clearTimeout(timer); timer = null; } };
    return Promise.race([
      Promise.resolve(promise).then((v) => { clear(); return v; }, (e) => { clear(); throw e; }),
      new Promise((resolve) => { timer = setTimeout(resolve, ms); })
    ]);
  }

  /**
   * Mirror a DEFINITE local count to the server. Called only from a device
   * that has its own localStorage counter: without that guard a second device
   * booting fresh would write 0 over the record of photos still held on the
   * first one, destroying the only evidence they were ever owed.
   */
  async function _writeMarkerOnce(n) {
    if (typeof n !== 'number' || isNaN(n) || n < 0) return;
    const last = lsGet(MARKER_MIRROR_KEY);
    if (last !== null && parseInt(last, 10) === n) return; // unchanged, skip the write
    const fs = firestore();
    if (!fs) return;
    const payload = {};
    payload[MARKER_FIELD] = n;
    payload[MARKER_AT_FIELD] = Date.now();

    // Record at ISSUE time, not on the ack.
    //
    // The mirror key's own name is "what we last pushed", and pushed is what
    // this moment is. Writing it after the await looks safer and is not: the
    // bound in writeMarker() abandons the WAIT at MARKER_WRITE_TIMEOUT_MS
    // while the write itself stays buffered and lands on reconnect. The next
    // link on the chain then reads a pre-write mirror, and the guard four
    // lines up drops its write as "unchanged" — so the number that would have
    // corrected the server is never issued, and the abandoned one lands after
    // it. Server left high, nothing scheduled to fix it, and after the next
    // sign-out purges the local counter the boot repair cannot fire either:
    // the rep is told to reshoot a roof whose photos are already uploaded.
    //
    // Serialising made this deterministic rather than merely likely — the
    // second link is now GUARANTEED to run before the first one's ack.
    //
    // Recording the intent up front is sound because Firestore delivers
    // mutations to a single document in issue order, so an abandoned write is
    // still a write that will land, and in the right order relative to the
    // next one.
    lsSet(MARKER_MIRROR_KEY, n);
    try {
      await fs.setDoc(fs.ref, payload, { merge: true });
    } catch (e) {
      // Undo only our own optimism. A later link may already have moved the
      // key on; clobbering it back would re-open the same skip in reverse.
      if (lsGet(MARKER_MIRROR_KEY) === String(n)) {
        if (last === null) { try { localStorage.removeItem(MARKER_MIRROR_KEY); } catch (_) {} }
        else lsSet(MARKER_MIRROR_KEY, last);
      }
      console.warn('[PhotoQueueRecovery] could not write the queue marker:', e && e.message);
    }
  }

  /**
   * The local counter is gone. That is either this device's first boot, or
   * the browser deleted everything we own. Ask the server which, and tell the
   * rep if photos were owed.
   *
   * The copy has to be true in BOTH readings the server can support, because
   * they are indistinguishable from here: this device was wiped, or the rep
   * is signing in on a second device while the photos still sit on the first.
   * "not on this device" and "open the app on the phone you shot them with"
   * hold either way — and in the wipe case, looking and finding nothing is
   * exactly the discovery we want them to make now rather than in a week.
   */
  /**
   * Returns whether we actually got an answer out of the server — NOT whether
   * we warned. The caller uses it to decide it is safe to stop asking, and
   * "the marker says nothing is owed" is just as much an answer as "three
   * photos were owed". A failed read is neither, and must keep us asking.
   */
  async function reportLossFromServer() {
    const marker = await readMarker();
    if (!marker) return false;
    if (!(marker.held > 0)) return true;
    // Acknowledged on the server, so it survives the sign-out purge that
    // erases every local flag we could have used instead. Still a successful
    // consult — we asked and the answer was "they already know".
    if (marker.ackAt && marker.ackAt === marker.at) return true;
    notify(
      marker.held === 1
        ? '1 photo taken offline never finished uploading and is not on this device. Open the app on the phone you shot it with, or reshoot it.'
        : marker.held + ' photos taken offline never finished uploading and are not on this device. Open the app on the phone you shot them with, or reshoot them.',
      'error'
    );
    // Acknowledge ONLY. The pending count is deliberately untouched: this
    // device does not know what it holds, and writing a 0 here would erase
    // the record of photos still sitting on the rep's other phone.
    await ackMarker(marker.at);
    return true;
  }

  /** Record that the rep has been told about this marker. */
  async function ackMarker(at) {
    const fs = firestore();
    if (!fs) return;
    const payload = {};
    payload[MARKER_ACK_FIELD] = at;
    try { await fs.setDoc(fs.ref, payload, { merge: true }); }
    catch (e) { console.warn('[PhotoQueueRecovery] could not acknowledge the loss:', e && e.message); }
  }

  /**
   * A loss notice must outlive the boot it appears on, so it goes to the
   * sticky banner and falls back to the toast only when there is no DOM to
   * hang it on. Everything else here still uses the toast.
   */
  function notify(msg, kind) {
    if (stickyNotice(msg)) return;
    toast(msg, kind);
  }

  function seed(store, n) {
    if (store && typeof store.seedLastKnown === 'function') store.seedLastKnown(n);
  }

  /**
   * { count, oldestAt } for this rep, tolerating an older cached store.js that
   * predates pendingStats (a stale service-worker cache can pair the two).
   */
  async function pendingStats(store, uid) {
    if (store && typeof store.pendingStats === 'function') return store.pendingStats(uid);
    if (store && typeof store.pendingForUid === 'function') {
      const n = await store.pendingForUid(uid);
      return typeof n === 'number' ? { count: n, oldestAt: 0 } : null;
    }
    return null;
  }

  // How long a photo may sit undelivered before we say something. WebKit's
  // purge is 7 days of no interaction and opening the app resets that clock,
  // so the danger is the stretch where the rep does NOT open it. Two days is
  // early enough to leave room to act and late enough that a rep who is
  // simply out of signal for an afternoon is not nagged.
  const STALE_AFTER_MS = 2 * 24 * 60 * 60 * 1000;

  /**
   * The only warning in this feature that fires while the photos still EXIST.
   * Everything else here is an autopsy: it reports a queue the browser has
   * already destroyed, and the rep can do nothing but reshoot. This one is
   * actionable, so it names the action.
   *
   * If a loss banner is already up, stickyNotice() keeps it and this message
   * is dropped rather than stacking two fixed banners over each other. That is
   * a deliberate ordering, not an accident: "photos are gone" outranks
   * "photos are late", and the two can only co-occur after a partial eviction.
   */
  function warnIfStale(stats) {
    if (!stats || !stats.count || !stats.oldestAt) return false;
    const ageMs = Date.now() - stats.oldestAt;
    if (!(ageMs >= STALE_AFTER_MS)) return false;
    const days = Math.max(1, Math.floor(ageMs / (24 * 60 * 60 * 1000)));
    const howLong = days === 1 ? '1 day' : days + ' days';
    notify(
      stats.count === 1
        ? '1 photo has been waiting ' + howLong + ' to upload. Connect to Wi-Fi and keep this app open until it finishes.'
        : stats.count + ' photos have been waiting ' + howLong + ' to upload. Connect to Wi-Fi and keep this app open until they finish.',
      'warning'
    );
    return true;
  }

  async function recover() {
    const store = window.NBDPhotoQueueStore;
    if (!store) return;

    // BOOT COST: this runs on every dashboard load, and on almost every load
    // there is nothing queued. Opening IndexedDB (and asking for storage
    // persistence) to discover that is waste, so take the synchronous
    // localStorage counter first and leave immediately when it positively
    // says the queue was empty as of the last mutation. `null` means we have
    // never written it — first boot, or localStorage was cleared out from
    // under a surviving IndexedDB — and that has to fall through to a real
    // check, or an eviction of the counter alone would strand real photos.
    const known = store.lastKnownCount();
    if (known === 0) {
      // The queue is provably empty — but a drain that ran OUTSIDE this
      // function (photo-engine's `online` listener, or its post-capture
      // flush) cleared the local counter without touching the server marker,
      // which still claims photos are owed. That stale number is harmless
      // until purgeAccountStorage() deletes the counter on the next sign-out;
      // the sign-in after that reads the marker, finds no local evidence, and
      // accuses the rep of losing photos that are sitting in the gallery.
      // Correct it here, while the mirror key still says what we filed.
      const filed = parseInt(lsGet(MARKER_MIRROR_KEY), 10);
      if (!isNaN(filed) && filed > 0) {
        waitForFirebase()
          .then((ok) => { if (ok) return writeMarker(0); })
          .catch(() => {});
      }
      return;
    }

    // Keep the origin exempt from WebKit's 7-day eviction for as long as the
    // browser will allow it. Cheap, idempotent, and the thing that makes
    // "survives leaving the app" true across days rather than hours.
    try { await store.requestPersistence(); } catch (_) {}

    if (!(await store.available())) return;

    // Tell the rep if the browser threw their queue away. Silence here is how
    // a rep finds out a week later that a claim's photos never existed. This
    // only ever catches a PARTIAL eviction — see the full-wipe branch below.
    try {
      const lost = await store.detectLoss();
      if (lost > 0) {
        notify(
          lost === 1
            ? '1 photo held offline was cleared by your browser and could not be uploaded'
            : lost + ' photos held offline were cleared by your browser and could not be uploaded',
          'error'
        );
      }
    } catch (_) {}

    // count() returns null when the read FAILED, which is not the same as an
    // empty queue and must not be treated as one — `null <= 0` is true, so a
    // naive check here would skip recovery whenever IndexedDB hiccuped and
    // leave real photos sitting unsent. Only a definite 0 stops us.
    const pending = await store.count();

    if (pending === 0) {
      // FULL WIPE. `known === null` means the store's own counter is gone as
      // well, so detectLoss() above had nothing to compare and returned 0 no
      // matter what was lost — this is the case it is structurally blind to.
      // An empty store plus a missing counter is either a first boot on this
      // device or a site-data clear, and only the server can tell us which.
      //
      // Nothing about the QUEUE is written back from here on purpose: in this
      // state the device knows nothing, and a pending count of 0 would erase
      // the record of photos still held on the rep's other phone.
      if (known === null) {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
        if (!(await waitForFirebase())) return;
        // Seeding the local counter is what makes this branch cost one server
        // read per device instead of one per BOOT — without it a rep who has
        // never queued a photo has no counter to write, so every dashboard
        // load re-opens IndexedDB, waits for auth and re-reads the marker,
        // forever. Seed only on a successful consult, though: seeding after an
        // unreachable server would send every later boot down the fast path
        // and the loss would never be reported at all.
        if (await reportLossFromServer()) seed(store, 0);
      }
      return;
    }

    // Rows exist and we have no baseline to measure them against. Establish
    // one now rather than staying blind until the next add()/remove(): our own
    // nbd-auth.js purgeAccountStorage() deletes the counter on EVERY logout
    // while leaving these rows alone, so without this a rep who signs out on
    // Friday and is evicted on Monday is never told anything. seedLastKnown()
    // refuses to overwrite an existing baseline, so this cannot mask a loss
    // the counter already had the evidence for.
    if (known === null) seed(store, pending);

    const offline = (typeof navigator !== 'undefined' && navigator.onLine === false);

    // Auth is restored from local state, so this resolves without a network
    // round-trip in the normal case. It is awaited even when offline because
    // the staleness warning below needs a uid: without one it would count the
    // rows of whichever rep last used this phone.
    const authed = await waitForFirebase();
    if (!authed) return;

    // Record what is owed BEFORE attempting the drain. If this drain fails,
    // or the tab dies mid-flight, or the browser wipes us next week, the
    // server still holds the count — and that record is the only thing a
    // wiped device can read on its next boot.
    //
    // Counted per UID, never with store.count(). `pending` above is every row
    // on the device, which is the right question for "should we drain?" and
    // the WRONG one for a number we are about to file under one person's name:
    // on a shared device it is the previous rep's backlog, which this rep's
    // drain will never touch (photo-engine filters by uid) and which would sit
    // on their marker forever, ready to accuse them of losing photos they
    // never took.
    const uid = window._user && window._user.uid;
    const stats = await pendingStats(store, uid);

    if (offline) {
      // There is no network to drain over, but there IS something to say: if
      // these photos have been sitting for days, this is the last cheap moment
      // to tell the rep while they still exist.
      warnIfStale(stats);
      return;
    }

    await writeMarker(stats ? stats.count : null);

    const ready = await loadPhotoEngine();
    if (!ready) { warnIfStale(stats); return; }

    try {
      await window.PhotoEngine.flushUploadQueue();
    } catch (e) {
      console.warn('[PhotoQueueRecovery] drain failed:', e && e.message);
    }

    // And what is still owed after it, so a drained queue stops warning about
    // photos that did arrive. A failed count is null, not 0, and writes nothing.
    const after = await pendingStats(store, uid);
    if (after) await writeMarker(after.count);
    warnIfStale(after);
  }

  /**
   * Re-file what this rep still owes, from anywhere.
   *
   * writeMarker() used to be reachable only from recover(), i.e. only on a
   * boot that found rows. The drains that do most of the real work are
   * elsewhere — photo-engine's `online` listener and its post-capture flush —
   * and both clear the local counter (store.remove() → _writeLastKnown) while
   * leaving the server marker frozen at the old number. That stale marker is
   * read back after the next sign-out purges the local counter, and the rep is
   * told to reshoot a roof whose photos already uploaded.
   *
   * Cheap to call: writeMarker() skips the network entirely when the number is
   * unchanged, and a failed count is null and writes nothing.
   */
  /**
   * Re-file what this rep still owes. Serialisation and the timeout live in
   * writeMarker() below, so every caller of it — this one and recover()'s
   * three — shares one queue rather than racing each other.
   *
   * Deliberately NOT gated on navigator.onLine. The obvious guard is a trap
   * here: Firestore buffers a write made on a dead connection and flushes it
   * when the connection returns, so skipping it turns a write that would have
   * landed into no write at all — and a stale marker is precisely what tells
   * the rep to reshoot a roof whose photos are already in the gallery. What
   * the caller actually needed protecting from was the unbounded WAIT, and
   * that is what the bound in writeMarker() gives it.
   */
  async function syncMarker() {
    const store = window.NBDPhotoQueueStore;
    const uid = window._user && window._user.uid;
    if (!store || !uid) return;
    try {
      // Through the shared helper, so this inherits its pendingStats →
      // pendingForUid fallback rather than hard-coding one of them: a stale
      // service-worker cache can pair this file with either shape of store.
      const stats = await pendingStats(store, uid);
      if (stats && typeof stats.count === 'number') await writeMarker(stats.count);
    } catch (e) {
      console.warn('[PhotoQueueRecovery] marker sync failed:', e && e.message);
    }
  }

  window.NBDPhotoQueueRecovery = { syncMarker };

  function start() {
    // Never let recovery break the dashboard boot.
    recover().catch((e) => console.warn('[PhotoQueueRecovery] failed:', e && e.message));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
