/**
 * sms-outbox.js — window.NBDSmsOutbox: texts written offline, sent when the
 * app is back online, and only if nothing changed in the meantime.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 * NBDComms.sendSMS used to answer "no network" by opening the rep's own
 * Messages app with the text filled in. Over plain cellular SMS that sends
 * immediately — with no opt-out check and nothing in sms_log. The approved
 * replacement (Jo, 2026-09-18): keep the text, and on reconnect check the
 * number's status first, check for competing messages, and send in order.
 *
 * ── The approved defaults ────────────────────────────────────────────────
 *   - Auto-send on reconnect only if the text is less than 15 minutes old.
 *   - Queued texts only ever auto-send between 08:00 and 21:00
 *     America/New_York (the SERVER decides this; see
 *     functions/sms-outbox-guard.js).
 *   - Anything else waits in the "Pending texts" tray for an explicit tap.
 *
 * ── What happens where ───────────────────────────────────────────────────
 *   nbd-comms.js   sendSMS cannot reach the server (navigator.onLine false,
 *                  fetch rejects, or the 25s abort) → enqueue() here, toast
 *                  "Queued …", return { success: true, mode: 'queued' }.
 *   this file      flush() on 'online', on page load once auth is ready, and
 *                  on visibilitychange → visible. Oldest first, one recipient
 *                  at a time, in order per recipient. Stale (≥15 min) → held.
 *                  Identical text to the same number already pending → one
 *                  copy is discarded as 'duplicate' (recorded, not silently
 *                  deleted; see the collapse rules in _flushInner). Each text
 *                  goes through NBDComms.sendQueued to the sendQueuedSMS
 *                  endpoint — sendSMS's handler with `queued` forced on, and
 *                  an endpoint an old deploy does not have, so a page ahead
 *                  of its functions keeps the text queued instead of having
 *                  it sent as a live text — with { clientMsgId, queuedAt,
 *                  queuedAgeMs, leadStageAtQueue }.
 *   sendQueuedSMS  opt-out first (403), then idempotency, quiet hours,
 *                  staleness, the lead, competing activity in the rep's
 *                  tenant (409 held), then the paid gate / limiters / Twilio.
 *   the tray       a "Pending texts (N)" pill → modal listing each held or
 *                  queued text with Send now / Send anyway / Edit / Discard,
 *                  or — for a text that may already have gone — Check again
 *                  (a peek that never sends) / Discard.
 *
 * A text queued after a LIVE attempt keeps that attempt's clientMsgId
 * (nbd-comms.js mints it before the fetch). If the attempt reached sendSMS
 * before the connection died, the server's claim on that id makes the replay
 * answer "in_flight" / "duplicate" instead of texting the homeowner twice.
 *
 * NOTHING in the flush path opens an sms: handoff. The one handoff this file
 * can open is the tray's explicit "Open in Messages", and only on a FRESH
 * server answer: the tap re-sends the text (queued: true) and hands off only
 * if THAT request answers 402 / 429 / provider_error — answers that, for a
 * queued text, come only after the opt-out register, quiet hours and the
 * activity checks passed in the same request (the contract nbd-comms.js
 * applies to a live 402/429). An old hold is never enough: the homeowner may
 * have replied STOP since, or it may be 11pm.
 *
 * ── Stamping what went out: receipts ─────────────────────────────────────
 * Invoices, deal rooms and portal shares are marked "sent" only when the text
 * really goes. The send can happen in another tab, on page load, or on a page
 * that never loads the stamping module (invoice-pipeline.js is lazy on
 * customer.html, close-board.js loads with its view). So a sent text that
 * carries source + sourceRef leaves a small RECEIPT here (no phone number, no
 * message) and each consumer registers with onSent(source, fn) when it loads;
 * the receipt is deleted only once a handler for its source has applied it.
 * Receipts are drained in every tab (BroadcastChannel), and pruned after a
 * week if nothing ever claims them.
 *
 * ── Storage: its own IndexedDB, not offline-manager's ────────────────────
 * Same reasoning as photo-queue-store.js's header: offline-manager.js's
 * `nbd-offline-db` / `pending-writes` store is the one sw.js's
 * flushOfflineQueue() replays as raw fetch(item.url, …) and deletes. A text
 * written there is one revived code path away from being sent by a service
 * worker with no opt-out check, no idempotency and no hold logic. So: DB
 * `nbd-sms-outbox-db`, store `outbox`, keyed by the client message id.
 *
 * ── PII on the device ────────────────────────────────────────────────────
 * A record holds the recipient's phone number and the message until it is
 * sent (then removed, or reduced to a receipt with neither) or discarded.
 * Every record carries the uid that wrote it and every read filters on the
 * signed-in uid. Every phone number and message is purged on sign-out
 * (nbd-auth.js purgeAccountStorage/logout, the dashboard's _signOut,
 * command-palette.js's SDK fallback on customer.html) and on account switch
 * (purgeAccountStorage's uid-change path, plus this module's own boot check).
 * As a backstop for any other sign-out path, this module also purges itself
 * when the page's auth (window.auth) reports no user after a signed-in one.
 * The one thing a sign-out keeps is a RECEIPT of a text that already went —
 * ids only, no number, no message (purgeAll) — so the same rep's invoice /
 * deal / share still gets stamped after they sign back in; an account switch
 * drops those too. Same class of data as the photo queue.
 *
 * ── No IndexedDB (private mode, storage disabled) ────────────────────────
 * enqueue() rejects with reason 'unavailable' and nbd-comms.js falls back to
 * the pre-outbox behaviour — the device-Messages handoff. Deliberately NOT a
 * localStorage queue: that would be phone numbers and message text in plain
 * synchronous storage that every script on the origin reads, with no
 * transaction to make the queued→sending step atomic across tabs.
 *
 * ── Deliberately not built ───────────────────────────────────────────────
 * No background send while the app is closed (no Background Sync — a text
 * must be re-checked by a live page with a signed-in rep). Email is unchanged.
 *
 * CSP: no inline handlers — one delegated click listener below, keyed on
 * [data-sms-outbox-action].
 */
(function () {
  'use strict';
  if (window.NBDSmsOutbox) return;

  const DB_NAME = 'nbd-sms-outbox-db';
  const DB_STORE = 'outbox';
  const DB_VERSION = 1;

  // Per signed-in user. Past this, enqueue() refuses out loud — the caller
  // tells the rep, nothing is dropped and nothing is handed off.
  const MAX_PER_USER = 50;
  // Mirrors functions/sms-outbox-guard.js STALE_MS (the server enforces it
  // too; tests/sms-outbox-server.test.js pins that the two agree).
  const STALE_MS = 15 * 60 * 1000;
  // A 'sending' record older than this was orphaned by a page that died
  // mid-request (well past nbd-comms.js's 25s abort). Replaying it is safe:
  // same clientMsgId, so the server answers "duplicate" if it already went.
  const SENDING_ORPHAN_MS = 2 * 60 * 1000;
  // A discarded record (duplicate / opted out) stays visible in the tray for
  // a day so the rep can see what happened, then is pruned.
  const DISCARDED_KEEP_MS = 24 * 60 * 60 * 1000;
  // Retry cadence while the page believes it is online but the server was
  // unreachable (captive portal, DNS, a 503 from a check that could not run).
  const RETRY_MS = 60 * 1000;

  const LOCK_NAME = 'nbd-sms-outbox-flush';
  const LEASE_KEY = 'nbd_sms_outbox_lease';
  const LEASE_MS = 45 * 1000;

  // A client message id the server accepts (functions/sms-outbox-guard.js
  // CLIENT_MSG_ID_RE). nbd-comms.js may hand enqueue() the id it already
  // sent on the live attempt; anything else gets a fresh one.
  const CLIENT_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

  // Receipts (see the header): kept until a handler for their source applies
  // them, at most this long. An 'acking' receipt older than ACK_ORPHAN_MS was
  // left by a page that died mid-handler and is offered again.
  const RECEIPT_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
  const ACK_ORPHAN_MS = 2 * 60 * 1000;
  const ACK_TIMEOUT_MS = 20 * 1000;

  // An edit remembers at most this many ids it replaces (server: MAX_SUPERSEDES).
  const MAX_SUPERSEDES = 5;

  // A held text that may already be on the homeowner's phone (held
  // 'in_flight', or a tap whose answer was lost) is re-asked by the automatic
  // flush with a PEEK — never a send — at most this often, so flushes on
  // every visibilitychange do not hammer the server with the same question.
  const PEEK_EVERY_MS = 2 * 60 * 1000;

  const ACTIVE = { queued: 1, sending: 1, held: 1 };

  // Server answers the tray may turn into a device handoff on an explicit tap
  // (see the header) — and only when the answer is FRESH, from a request made
  // at the moment of the tap. Each comes only after the opt-out + hold checks
  // passed in that same request.
  const HANDOFF_OK = { plan_required: 1, rate_limited: 1, provider_error: 1 };
  // Holds the rep may override with "Send anyway" (overrideActivity). The
  // server enforces the same list; this only decides which button to show.
  const ACTIVITY_HOLDS = { recent_outbound: 1, recent_inbound: 1, lead_changed: 1 };

  const REASON_TEXT = {
    queued: 'Waiting for a connection',
    queued_behind: 'Waiting behind an earlier text to this number',
    sending: 'Sending…',
    stale: 'Waiting — sent more than 15 min ago',
    quiet_hours: 'Quiet hours — can send after 8am',
    recent_inbound: 'Homeowner texted you since',
    recent_outbound: 'Someone already texted this number',
    lead_changed: 'Lead changed',
    lead_gone: 'Lead was deleted',
    in_flight: 'May already have gone — check the conversation first',
    not_sent: 'Not sent — the earlier try did not go out. Review it, then send',
    plan_required: 'Texting from the app needs a paid plan',
    rate_limited: 'Text limit reached — try later',
    provider_error: 'Text provider error — try again',
    invalid: 'Couldn\'t send — check the number or message',
    refused: 'Couldn\'t send to this number',
    error: 'Couldn\'t send',
    opted_out: 'Opted out',
    duplicate: 'Duplicate — the same text was already waiting',
  };

  function _now() { return Date.now(); }

  function _fail(reason, message) {
    const e = new Error(message);
    e.reason = reason;
    return e;
  }

  function _toast(msg, type) {
    try { if (typeof window.showToast === 'function') window.showToast(msg, type); } catch (_) {}
  }

  // Byte-identical to functions/phone-utils.js phoneDigits10 (the browser
  // lead-write paths inline the same one-liner).
  function _digits10(phone) {
    return String(phone == null ? '' : phone).replace(/\D/g, '').replace(/^1/, '').slice(-10);
  }

  function _newId() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    } catch (_) {}
    try {
      if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
        const b = new Uint8Array(16);
        window.crypto.getRandomValues(b);
        return Array.prototype.map.call(b, (x) => ('0' + x.toString(16)).slice(-2)).join('');
      }
    } catch (_) {}
    // Last resort. Uniqueness matters (it is the idempotency key), secrecy
    // does not: the server scopes it per uid.
    return 'm' + _now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  }

  function _uid() {
    const u = window._user
      || (window.auth && window.auth.currentUser)
      || (window._auth && window._auth.currentUser)
      || null;
    return (u && typeof u.uid === 'string' && u.uid) || null;
  }

  // ── IndexedDB ─────────────────────────────────────────────────────────
  let _db = null;
  let _openPromise = null;

  function _forget() { _db = null; _openPromise = null; }

  function _open() {
    if (_db) return Promise.resolve(_db);
    if (_openPromise) return _openPromise;
    const attempt = new Promise((resolve) => {
      let req;
      try {
        if (!window.indexedDB) { resolve(null); return; }
        req = window.indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) {
        // Private-mode Safari throws from open() itself.
        resolve(null);
        return;
      }
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains(DB_STORE)) d.createObjectStore(DB_STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => {
        const d = req.result;
        try {
          d.onclose = () => { if (_db === d) _forget(); };
          // A schema upgrade or a deleteDatabase from another page must not
          // be blocked by a connection that ignored versionchange.
          d.onversionchange = () => { try { d.close(); } catch (_) {} if (_db === d) _forget(); };
        } catch (_) {}
        _db = d;
        resolve(d);
      };
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    });
    _openPromise = attempt;
    // A failed open must not be cached (see photo-queue-store.js _open):
    // drop the memo after the assignment above, in a microtask.
    attempt.then((d) => { if (!d && _openPromise === attempt) _openPromise = null; });
    return attempt;
  }

  /**
   * One transaction. `body(store, done, refuse)` issues requests; `done(v)`
   * sets the resolved value, `refuse(err)` aborts and rejects with err.
   * Resolves only once the transaction COMMITS.
   */
  function _run(mode, body) {
    return _open().then((db) => {
      if (!db) throw _fail('unavailable', 'SMS outbox storage unavailable');
      let tx;
      try {
        tx = db.transaction(DB_STORE, mode);
      } catch (e) {
        _forget();
        throw _fail('unavailable', 'SMS outbox transaction failed: ' + (e && e.name));
      }
      return new Promise((resolve, reject) => {
        let value;
        let refusal = null;
        tx.oncomplete = () => { if (refusal) reject(refusal); else resolve(value); };
        tx.onabort = () => {
          if (refusal) { reject(refusal); return; }
          const name = tx.error && tx.error.name;
          reject(_fail(name === 'QuotaExceededError' ? 'quota' : 'write-failed',
            'SMS outbox transaction aborted: ' + (name || 'unknown')));
        };
        const done = (v) => { value = v; };
        const refuse = (err) => { refusal = err; try { tx.abort(); } catch (_) {} };
        try {
          body(tx.objectStore(DB_STORE), done, refuse);
        } catch (e) {
          refuse(_fail('write-failed', 'SMS outbox request failed: ' + (e && (e.name || e.message))));
        }
      });
    });
  }

  function _all() {
    return _run('readonly', (store, done) => {
      const r = store.getAll();
      r.onsuccess = () => done(Array.isArray(r.result) ? r.result : []);
    });
  }

  /**
   * Read-modify-write ONE record in ONE transaction. `mutate(copy)` returns
   * the new record, or null to leave it alone — e.g. because another tab
   * already moved it. Resolves to the stored record, or null.
   */
  function _mutate(id, uid, mutate) {
    return _run('readwrite', (store, done) => {
      const r = store.get(id);
      r.onsuccess = () => {
        const cur = r.result;
        if (!cur || cur.uid !== uid) { done(null); return; }
        const next = mutate(Object.assign({}, cur));
        if (!next) { done(null); return; }
        next.updatedAt = _now();
        store.put(next);
        done(next);
      };
    });
  }

  function _remove(id, uid) {
    return _run('readwrite', (store, done) => {
      const r = store.get(id);
      r.onsuccess = () => {
        const cur = r.result;
        if (!cur || cur.uid !== uid) { done(false); return; }
        store.delete(id);
        done(true);
      };
    });
  }

  function _byAge(a, b) {
    return (a.createdAt - b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }

  let _persistAsked = false;
  function _requestPersistence() {
    if (_persistAsked) return;
    _persistAsked = true;
    try {
      if (navigator.storage && typeof navigator.storage.persist === 'function') {
        navigator.storage.persisted()
          .then((already) => (already ? true : navigator.storage.persist()))
          .catch(() => false);
      }
    } catch (_) {}
  }

  // ── Public store API ──────────────────────────────────────────────────

  /**
   * Store one text. Resolves to the record once COMMITTED; rejects with
   * e.reason: 'bad-item' | 'unavailable' | 'queue-full' | 'quota' | 'write-failed'.
   */
  async function enqueue(input) {
    const i = input || {};
    const uid = typeof i.uid === 'string' ? i.uid : '';
    const to = typeof i.to === 'string' ? i.to.trim() : '';
    const body = typeof i.body === 'string' ? i.body : '';
    if (!uid) throw _fail('bad-item', 'SMS outbox needs the signed-in user');
    if (!to || !_digits10(to)) throw _fail('bad-item', 'SMS outbox needs a phone number');
    if (!body.trim()) throw _fail('bad-item', 'SMS outbox needs a message');
    const createdAt = (typeof i.createdAt === 'number' && isFinite(i.createdAt)) ? i.createdAt : _now();
    const rec = {
      // The live attempt's id when there was one (nbd-comms.js): the server
      // may already hold a claim on it, which is the whole point.
      id: (typeof i.id === 'string' && CLIENT_ID_RE.test(i.id)) ? i.id : _newId(),
      uid: uid,
      to: to,
      toDigits: _digits10(to),
      body: body,
      leadId: (typeof i.leadId === 'string' && i.leadId) || null,
      knockId: (typeof i.knockId === 'string' && i.knockId) || null,
      source: (typeof i.source === 'string' && i.source) || null,
      sourceRef: (typeof i.sourceRef === 'string' && i.sourceRef) || null,
      leadStageAtQueue: (typeof i.leadStageAtQueue === 'string' && i.leadStageAtQueue) || null,
      createdAt: createdAt,
      status: 'queued',
      heldReason: null,
      heldMessage: null,
      attempts: 0,
      // True while this id's last attempt ended without a server verdict
      // (network drop, 5xx): it may have gone out. See _flushInner.
      uncertain: !!i.uncertain,
      supersedes: null,
      overrides: {},
      updatedAt: _now(),
    };
    _requestPersistence();
    const stored = await _run('readwrite', (store, done, refuse) => {
      const r = store.getAll();
      r.onsuccess = () => {
        const rows = Array.isArray(r.result) ? r.result : [];
        // Counted INSIDE the write transaction, so two tabs enqueueing at
        // once cannot both squeeze past the cap.
        const active = rows.filter((x) => x && x.uid === uid && ACTIVE[x.status]).length;
        if (active >= MAX_PER_USER) {
          refuse(_fail('queue-full', 'SMS outbox is full (' + MAX_PER_USER + ')'));
          return;
        }
        store.add(rec);
        done(rec);
      };
    });
    _changed();
    // Queued while the browser still says "online" means the server was
    // unreachable for some other reason; no 'online' event will come.
    if (typeof navigator === 'undefined' || navigator.onLine !== false) _scheduleRetry();
    return stored;
  }

  /**
   * The signed-in user's texts — waiting (queued / sending / held) or
   * discarded — oldest first. Receipts of sent texts are not listed.
   * Rejects when storage is unusable.
   */
  async function list(uid) {
    const u = uid || _uid();
    if (!u) return [];
    const rows = await _all();
    return rows.filter((r) => r && r.uid === u && (ACTIVE[r.status] || r.status === 'discarded')).sort(_byAge);
  }

  /** How many texts are waiting (queued / sending / held) for the signed-in user; null when unknown. */
  async function pendingCount(uid) {
    try {
      const rows = await list(uid);
      return rows.filter((r) => ACTIVE[r.status]).length;
    } catch (_) {
      return null;
    }
  }

  /**
   * A receipt that holds nothing personal: the phone number and the message
   * were dropped when the text went (_recordSent), and what is left is ids.
   * nbd-auth.js purgeSmsOutbox's bare-page path applies the same rule.
   */
  function _isPiiFreeReceipt(r) {
    return _isReceipt(r) && (r.status === 'sent' || r.status === 'acking') && !r.to && !r.toDigits && !r.body;
  }

  /**
   * Sign-out / account switch: delete every record for every user — every
   * phone number and every message — EXCEPT receipts of texts that already
   * went out. A receipt carries only ids ("invoice inv-9's text went"), and
   * deleting one un-applied reopens the double text it exists to prevent: the
   * invoice stays draft, the rep signs back in and sends it again. The same
   * rep applies it on their next sign-in; another account never sees it
   * (every read is uid-scoped, and _purgeOtherUsers drops it at their boot).
   */
  async function purgeAll() {
    let ok = false;
    try {
      ok = await _run('readwrite', (store, done) => {
        const r = store.getAll();
        r.onsuccess = () => {
          (Array.isArray(r.result) ? r.result : []).forEach((x) => {
            if (x && x.id != null && !_isPiiFreeReceipt(x)) store.delete(x.id);
          });
          done(true);
        };
      });
    } catch (_) {
      ok = false;
    }
    _hidePill();
    _closeTray();
    return !!ok;
  }

  /** Account switch on this device: drop every record that is not `uid`'s. */
  async function _purgeOtherUsers(uid) {
    if (!uid) return 0;
    return _run('readwrite', (store, done) => {
      const r = store.getAll();
      r.onsuccess = () => {
        let n = 0;
        (Array.isArray(r.result) ? r.result : []).forEach((x) => {
          if (x && x.uid !== uid) { store.delete(x.id); n++; }
        });
        done(n);
      };
    });
  }

  // ── Flush ─────────────────────────────────────────────────────────────
  const TAB_ID = _newId();
  let _flushing = null;
  let _flushAgain = false;
  let _retryTimer = null;
  let _lastUid = null;

  function _acquireLease() {
    try {
      const now = _now();
      const raw = localStorage.getItem(LEASE_KEY);
      const cur = raw ? JSON.parse(raw) : null;
      if (cur && cur.owner !== TAB_ID && cur.until > now) return false;
      localStorage.setItem(LEASE_KEY, JSON.stringify({ owner: TAB_ID, until: now + LEASE_MS }));
      const back = JSON.parse(localStorage.getItem(LEASE_KEY) || 'null');
      return !!back && back.owner === TAB_ID;
    } catch (_) {
      // No usable localStorage: tabs cannot coordinate here. Going on is still
      // safe — every text moves queued → sending inside an IndexedDB
      // transaction first (two tabs cannot both take it), and the server's
      // clientMsgId claim stops a double send even if they somehow did.
      return true;
    }
  }

  function _releaseLease() {
    try {
      const cur = JSON.parse(localStorage.getItem(LEASE_KEY) || 'null');
      if (cur && cur.owner === TAB_ID) localStorage.removeItem(LEASE_KEY);
    } catch (_) {}
  }

  function _scheduleRetry() {
    if (_retryTimer) return;
    _retryTimer = setTimeout(() => { _retryTimer = null; flush('retry'); }, RETRY_MS);
  }

  /**
   * Send what can be sent. Single-flight: one flush per tab (concurrent calls
   * share it) and one per origin (navigator.locks, else a localStorage lease).
   * Resolves to a summary; never rejects.
   */
  function flush(reason) {
    if (_flushing) {
      // A run is already going, but it may have read the queue before the
      // text that prompted this call was stored. Join it, and run once more
      // after it (one trailing run, however many calls pile up).
      _flushAgain = true;
      return _flushing;
    }
    _flushing = (async () => {
      try {
        return await _flushLocked(reason || 'manual');
      } catch (e) {
        console.warn('[NBDSmsOutbox] flush failed:', e && e.message);
        return { skipped: 'error' };
      } finally {
        _flushing = null;
        if (_flushAgain) {
          _flushAgain = false;
          setTimeout(() => { flush('trailing'); }, 0);
        }
      }
    })();
    return _flushing;
  }

  async function _flushLocked(reason) {
    const uid = _uid();
    if (!uid) return { skipped: 'no-user' };
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return { skipped: 'offline' };
    if (!window.NBDComms || typeof window.NBDComms.sendQueued !== 'function') return { skipped: 'no-comms' };
    if (_lastUid !== uid) {
      // First flush for this user in this page, or the account changed under
      // us: whatever another account left here is not ours to send or show.
      try { await _purgeOtherUsers(uid); } catch (_) {}
      _lastUid = uid;
    }
    const locks = (typeof navigator !== 'undefined' && navigator.locks
      && typeof navigator.locks.request === 'function') ? navigator.locks : null;
    if (locks) {
      return locks.request(LOCK_NAME, { ifAvailable: true }, (lock) => {
        if (!lock) return { skipped: 'busy' };
        return _flushInner(uid, reason);
      });
    }
    if (!_acquireLease()) return { skipped: 'busy' };
    try {
      return await _flushInner(uid, reason);
    } finally {
      _releaseLease();
    }
  }

  async function _flushInner(uid, reason) {
    const summary = { reason: reason, sent: 0, held: 0, duplicates: 0, optedOut: 0, stoppedBy: null };
    let rows;
    try {
      rows = (await _all()).filter((r) => r && r.uid === uid).sort(_byAge);
    } catch (_) {
      summary.stoppedBy = 'storage';
      return summary;
    }

    const start = _now();

    // Housekeeping: a 'sent' row that is not a receipt (its removal did not
    // commit) is removed now, and so is a receipt nothing claimed in a week;
    // a receipt a dead page was applying is offered again; orphaned 'sending'
    // rows go back to 'queued'; old discarded rows are pruned.
    for (const r of rows) {
      if (r.status === 'sent') {
        if (!_isReceipt(r) || start - (r.sentAt || r.updatedAt || 0) > RECEIPT_KEEP_MS) {
          await _remove(r.id, uid).catch(() => false);
          r.status = 'pruned';
        }
      } else if (r.status === 'acking' && start - (r.ackingAt || r.updatedAt || 0) > ACK_ORPHAN_MS) {
        await _mutate(r.id, uid, (cur) => (cur.status === 'acking'
          ? Object.assign(cur, { status: 'sent', ackingAt: null }) : null)).catch(() => null);
      } else if (r.status === 'sending' && start - (r.sendingAt || r.updatedAt || 0) > SENDING_ORPHAN_MS) {
        const back = await _mutate(r.id, uid, (cur) => (cur.status === 'sending'
          // The page died mid-request: whether it reached the server is
          // unknown, so the replay (same id) must ask the server first.
          ? Object.assign(cur, { status: 'queued', uncertain: true }) : null)).catch(() => null);
        if (back) Object.assign(r, back);
      } else if (r.status === 'discarded' && start - (r.discardedAt || r.updatedAt || 0) > DISCARDED_KEEP_MS) {
        await _remove(r.id, uid).catch(() => false);
        r.status = 'pruned';
      }
    }

    // Duplicate collapse — the same words to the same number twice. One copy
    // goes on, the other is recorded as 'discarded' (reason 'duplicate'),
    // never silently deleted. Which one is decided by what each copy may
    // already have done:
    //   - "certainly unsent": queued or held with no attempt left unanswered
    //     (not 'sending', not held 'in_flight', not `uncertain`);
    //   - "may have gone": everything else — it may be on the homeowner's
    //     phone already, and only a replay under ITS OWN id can find that out
    //     (the server's claim answers "duplicate") and carry its receipt.
    // Rules, for an older copy and a newer QUEUED copy:
    //   - older certainly unsent and HELD → the older is retired. It waits for
    //     a tap and would otherwise sit ahead of the new copy in this
    //     number's FIFO and stop it from ever going on its own;
    //   - older certainly unsent, newer MAY HAVE GONE (a live attempt whose
    //     answer was lost) → the older is retired, so the uncertain copy is
    //     the one replayed: its id dedupes it and its receipt stamps the
    //     invoice. Retiring the uncertain one instead replayed the older copy
    //     under an id the server had never seen — a second text if the first
    //     was still inside Twilio, and a lost receipt either way;
    //   - otherwise (both certainly unsent, or the older may have gone) → the
    //     newer is discarded and the older goes on.
    const firstByText = {};
    const mayHaveGone = (x) => x.status === 'sending' || (x.status === 'held' && x.heldReason === 'in_flight') || !!x.uncertain;
    const discardAsDuplicate = async (loser, keepId, fromStatus) => {
      const dup = await _mutate(loser.id, uid, (cur) => (cur.status === fromStatus
        ? Object.assign(cur, { status: 'discarded', heldReason: 'duplicate', duplicateOf: keepId, discardedAt: _now() })
        : null)).catch(() => null);
      if (dup) { Object.assign(loser, dup); summary.duplicates++; }
      return !!dup;
    };
    for (const r of rows) {
      if (!ACTIVE[r.status]) continue;
      const key = r.toDigits + '\u0000' + r.body;
      const first = firstByText[key];
      if (!first) { firstByText[key] = r; continue; }
      if (r.status !== 'queued') continue;
      const retireOlder = !mayHaveGone(first) && (first.status === 'held' || mayHaveGone(r));
      if (retireOlder) {
        if (await discardAsDuplicate(first, r.id, first.status)) firstByText[key] = r;
      } else {
        await discardAsDuplicate(r, first.id, 'queued');
      }
    }

    // Per-recipient FIFO. Recipients in order of their oldest pending text;
    // within a recipient, strictly in order — a text that does not go (held,
    // or still in flight elsewhere) holds back every later one to that number.
    const order = [];
    const byRecipient = {};
    for (const r of rows) {
      if (!ACTIVE[r.status]) continue;
      if (!byRecipient[r.toDigits]) { byRecipient[r.toDigits] = []; order.push(r.toDigits); }
      byRecipient[r.toDigits].push(r);
    }

    outer:
    for (const key of order) {
      for (const r of byRecipient[key]) {
        // Held, but it may already be on the homeowner's phone ('in_flight',
        // or an explicit tap whose answer never came back): ask the server
        // with a PEEK — never a send, never an override. "duplicate" applies
        // it as sent (its receipt stamps the invoice) and lets the next text
        // to this number go; "not_claimed" turns it into an ordinary hold
        // that needs an explicit Send now. Otherwise it still blocks the queue.
        if (_maybeGone(r)) {
          if (_now() - (r.peekedAt || 0) < PEEK_EVERY_MS) break;
          const peeked = await _peekOne(r, uid, summary);
          if (peeked === 'stop-all') break outer;
          if (peeked !== 'continue') break;
          continue;
        }
        if (r.status !== 'queued') break;           // held / sending ahead of it
        // Too old to send without the rep looking at it — decided HERE, with
        // no server call, only for a text that has never reached the server.
        // One that may have (a live attempt or a replay whose answer was
        // lost) goes to the server without overrides: the idempotency peek
        // runs first there and answers "duplicate" if it already went, else
        // the server's own stale rule holds it. A local hold would show a
        // delivered text as unsent — and invite an Edit or a Discard that
        // skips the invoice / deal stamp.
        if (_now() - r.createdAt >= STALE_MS && !(r.attempts > 0 || r.uncertain)) {
          const held = await _mutate(r.id, uid, (cur) => (cur.status === 'queued'
            ? Object.assign(cur, { status: 'held', heldReason: 'stale', heldMessage: null, heldAt: _now() })
            : null)).catch(() => null);
          if (held) summary.held++;
          break;
        }
        const step = await _sendOne(r, uid, cur => cur.status === 'queued', {}, summary, false);
        if (step === 'stop-all') break outer;
        if (step !== 'continue') break;
      }
    }

    if (summary.stoppedBy === 'network' || summary.stoppedBy === 'retry') {
      if (typeof navigator === 'undefined' || navigator.onLine !== false) _scheduleRetry();
    }
    _announce(summary);
    _changed();
    // Receipts a handler could not apply last time (Firestore not ready,
    // offline) get another go on every flush. Not awaited: a slow handler
    // must not hold the flush lock.
    _drainReceipts();
    return summary;
  }

  /**
   * Move one record to 'sending' (only if `canTake(cur)` — the cross-tab
   * compare-and-set), replay it, and record the outcome. Returns
   * 'continue' | 'stop-recipient' | 'stop-all' | 'skipped'.
   */
  async function _sendOne(r, uid, canTake, overrides, summary, explicit) {
    const prev = { status: r.status, heldReason: r.heldReason || null, heldMessage: r.heldMessage || null };
    let claimed;
    try {
      claimed = await _mutate(r.id, uid, (cur) => (canTake(cur)
        ? Object.assign(cur, {
          status: 'sending',
          sendingAt: _now(),
          attempts: (cur.attempts || 0) + 1,
          // What THIS attempt was allowed to skip — never carried over from
          // an earlier tap, which answered a different, older hold.
          overrides: Object.assign({}, overrides || {}),
        })
        : null));
    } catch (_) {
      summary.stoppedBy = 'storage';
      return 'stop-all';
    }
    if (!claimed) return 'skipped';                 // another tab moved it first

    // Consent is per tap: an automatic flush never carries an override, even
    // for a record the rep once tapped (and whose send then failed offline).
    const ov = explicit ? (claimed.overrides || {}) : {};
    let res;
    try {
      res = await window.NBDComms.sendQueued(claimed, {
        overrideStale: ov.stale === true,
        overrideActivity: ov.activity === true,
      });
    } catch (e) {
      res = { outcome: 'network', message: e && e.message };
    }
    res = res || { outcome: 'retry' };
    // The caller (openInMessages) acts on THIS request's answer, never on a
    // stored one.
    summary.last = res;
    const setStatus = (patch) => _mutate(claimed.id, uid, (cur) => (cur.status === 'sending'
      ? Object.assign(cur, patch) : null)).catch(() => null);

    switch (res.outcome) {
      case 'sent':
      case 'duplicate': {
        await _recordSent(claimed, uid, res);
        summary.sent++;
        return 'continue';
      }
      case 'opted_out': {
        await setStatus({ status: 'discarded', heldReason: 'opted_out', heldMessage: res.message || null, discardedAt: _now(), uncertain: false });
        summary.optedOut++;
        _toast('Queued text to ' + _mask(claimed.toDigits) + ' was NOT sent — they opted out of texts (replied STOP).', 'error');
        return 'continue';
      }
      case 'held':
      case 'refused': {
        await setStatus({
          status: 'held',
          heldReason: res.reason || (res.outcome === 'refused' ? 'refused' : 'error'),
          heldMessage: res.message || null,
          heldAt: _now(),
          // A verdict: the server looked at this id and did not send it
          // (in_flight is its own "may have gone" state).
          uncertain: false,
        });
        summary.held++;
        return 'stop-recipient';
      }
      default: {
        // network / retry / auth: it never got a verdict. Put it back as it
        // was — a flush's text stays queued, an explicit tap's stays held —
        // but remember that a network drop or a 5xx may have come AFTER the
        // server sent it, so nothing later treats it as certainly unsent.
        // Not when no request can have left (offline pre-check, the ID token
        // could not be minted) or the server's answer says nothing was sent
        // (503 outbox_unverified / throttled, a 404 from a deploy without
        // sendQueuedSMS): `neverSent`.
        const back = Object.assign({}, prev);
        if ((res.outcome === 'network' || res.outcome === 'retry') && !res.neverSent) back.uncertain = true;
        await setStatus(back);
        summary.stoppedBy = res.outcome === 'auth' ? 'auth' : (res.outcome === 'retry' ? 'retry' : 'network');
        if (explicit) summary.lastMessage = res.message || null;
        return 'stop-all';
      }
    }
  }

  /**
   * A held text that may already be on the homeowner's phone: held
   * 'in_flight' by the server, or held with `uncertain` (an explicit tap —
   * Send now, Send anyway, Open in Messages — whose answer never came back).
   * The tray shows it as "May already have gone" with Check again / Discard,
   * and the flush re-asks the server about it with a peek.
   */
  function _maybeGone(r) {
    return !!r && r.status === 'held' && (r.heldReason === 'in_flight' || !!r.uncertain);
  }

  /**
   * Ask the server whether a held text went — NBDComms.peekQueued, which never
   * sends — and record the answer. Returns 'continue' (it went: recorded as
   * sent) | 'stop-recipient' | 'stop-all' (no answer).
   */
  async function _peekOne(r, uid, summary) {
    let res;
    try {
      res = await window.NBDComms.peekQueued(r);
    } catch (e) {
      res = { outcome: 'network', message: e && e.message, neverSent: true };
    }
    res = res || { outcome: 'retry', neverSent: true };
    summary.last = res;
    const onHeld = (fn) => _mutate(r.id, uid, (cur) => (cur.status === 'held'
      ? Object.assign(cur, fn(cur), { peekedAt: _now() }) : null)).catch(() => null);
    switch (res.outcome) {
      case 'duplicate': {
        await _recordSent(r, uid, res, { from: 'held' });
        summary.sent++;
        return 'continue';
      }
      case 'held': {
        // Still claimed / unknown ('in_flight'), or an edit whose original
        // went ('recent_outbound' — Send anyway is the rep's call).
        const reason = res.reason || 'in_flight';
        await onHeld(() => ({ heldReason: reason, heldMessage: res.message || null, heldAt: _now(), uncertain: false }));
        summary.peeked = reason;
        return 'stop-recipient';
      }
      case 'not_claimed': {
        // Nothing of it reached Twilio: it did not go. An in_flight hold
        // becomes an ordinary one ('not_sent'); a tap whose answer was lost
        // is back to the hold it answered. Either way it needs an explicit
        // Send now — "Check again" was consent to check, not to send.
        await onHeld((cur) => (cur.heldReason === 'in_flight'
          ? { heldReason: 'not_sent', heldMessage: null, uncertain: false }
          : { uncertain: false }));
        summary.peeked = 'not_claimed';
        return 'stop-recipient';
      }
      default: {
        await onHeld(() => ({}));
        summary.stoppedBy = res.outcome === 'auth' ? 'auth' : (res.outcome === 'retry' ? 'retry' : 'network');
        return 'stop-all';
      }
    }
  }

  // ── Sent: receipts for the callers that stamp things ──────────────────

  function _isReceipt(r) {
    return !!(r && typeof r.source === 'string' && r.source && typeof r.sourceRef === 'string' && r.sourceRef);
  }

  /**
   * A text went out (now, or on an earlier attempt whose answer was lost, or
   * from the rep's own Messages app after "Open in Messages").
   * With a source + sourceRef it becomes a RECEIPT — phone number and message
   * dropped — that waits here until a handler registered with onSent() for
   * that source applies it; without one it is simply removed.
   * opts: { from: the status it must still be in ('sending' by default —
   *         'held' for a peek's "duplicate" and a handoff), via: 'platform' |
   *         'handoff' }
   */
  async function _recordSent(rec, uid, res, opts) {
    const from = (opts && opts.from) || 'sending';
    const via = (opts && opts.via) || 'platform';
    const sid = (res && res.sid) || null;
    const duplicate = !!(res && res.outcome === 'duplicate');
    if (_isReceipt(rec)) {
      await _mutate(rec.id, uid, (cur) => (cur.status === from
        ? Object.assign(cur, {
          status: 'sent', sentAt: _now(), sid: sid, duplicate: duplicate, via: via,
          to: '', toDigits: '', body: '', heldReason: null, heldMessage: null, overrides: {},
        })
        : null)).catch(() => null);
    } else {
      await _mutate(rec.id, uid, (cur) => (cur.status === from
        ? Object.assign(cur, { status: 'sent', sentAt: _now(), sid: sid }) : null)).catch(() => null);
      await _remove(rec.id, uid).catch(() => false);
    }
    try {
      // In-tab notification only (UI refresh). Stamps that must not be lost
      // use onSent(): this event reaches only listeners loaded in THIS tab.
      window.dispatchEvent(new CustomEvent('nbd:sms-outbox-sent', {
        detail: {
          id: rec.id, leadId: rec.leadId, knockId: rec.knockId,
          source: rec.source, sourceRef: rec.sourceRef,
          sid: sid, duplicate: duplicate, via: via,
        },
      }));
    } catch (_) {}
    if (_isReceipt(rec)) {
      if (_bc) { try { _bc.postMessage('receipt'); } catch (_) {} }
      _drainReceipts();
    }
  }

  // source → handler(detail) for this tab (see onSent).
  const _handlers = {};
  let _draining = null;
  let _drainAgain = false;

  /**
   * A caller that stamps something when its text goes out (invoice → sent,
   * deal → SENT, portal share) registers here. `handler(detail)` gets
   * { id, source, sourceRef, leadId, knockId, sid, sentAt, duplicate, via }
   * (via: 'platform', or 'handoff' when the rep sent it from their own
   * Messages app through the tray's "Open in Messages" — the same thing a
   * live 402/429 handoff's mode 'sms' means to the caller) and
   * may return a promise. Resolving (with anything) applies the receipt and
   * deletes it; throwing / rejecting leaves it for the next drain (e.g. the
   * page's Firestore globals are not up yet). Receipts already waiting — from
   * another tab, from before this module loaded — are applied now.
   */
  function onSent(source, handler) {
    if (typeof source !== 'string' || !source || typeof handler !== 'function') return false;
    _handlers[source] = handler;
    _drainReceipts();
    return true;
  }

  function _drainReceipts() {
    if (!Object.keys(_handlers).length) return Promise.resolve();
    if (_draining) { _drainAgain = true; return _draining; }
    _draining = (async () => {
      try { await _drainInner(); }
      catch (e) { console.warn('[NBDSmsOutbox] receipt drain failed:', e && e.message); }
      finally {
        _draining = null;
        if (_drainAgain) { _drainAgain = false; setTimeout(() => { _drainReceipts(); }, 0); }
      }
    })();
    return _draining;
  }

  function _withTimeout(p, ms) {
    let t;
    return Promise.race([
      Promise.resolve(p),
      new Promise((_, reject) => { t = setTimeout(() => reject(new Error('handler timed out')), ms); }),
    ]).finally(() => clearTimeout(t));
  }

  async function _drainInner() {
    const uid = _uid();
    if (!uid) return;
    const rows = (await _all()).filter((r) => r && r.uid === uid && r.status === 'sent'
      && _isReceipt(r) && typeof _handlers[r.source] === 'function').sort(_byAge);
    for (const r of rows) {
      // Cross-tab compare-and-set: only one tab applies a receipt.
      const taken = await _mutate(r.id, uid, (cur) => (cur.status === 'sent'
        ? Object.assign(cur, { status: 'acking', ackingAt: _now() }) : null)).catch(() => null);
      if (!taken) continue;
      let applied = false;
      try {
        await _withTimeout(_handlers[r.source]({
          id: taken.id, source: taken.source, sourceRef: taken.sourceRef,
          leadId: taken.leadId || null, knockId: taken.knockId || null,
          sid: taken.sid || null, sentAt: taken.sentAt || null, duplicate: !!taken.duplicate,
          via: taken.via || 'platform',
        }), ACK_TIMEOUT_MS);
        applied = true;
      } catch (e) {
        console.warn('[NBDSmsOutbox] ' + r.source + ' receipt not applied yet:', e && e.message);
      }
      if (applied) await _remove(r.id, uid).catch(() => false);
      else {
        await _mutate(r.id, uid, (cur) => (cur.status === 'acking'
          ? Object.assign(cur, { status: 'sent', ackingAt: null }) : null)).catch(() => null);
      }
    }
  }

  function _announce(summary) {
    if (summary.sent > 0) {
      _toast(summary.sent === 1 ? 'Queued text sent' : ('Sent ' + summary.sent + ' queued texts'), 'success');
    }
    if (summary.held > 0) {
      _toast(summary.held === 1
        ? '1 queued text needs your OK — open Pending texts'
        : (summary.held + ' queued texts need your OK — open Pending texts'), 'warning');
    }
    if (summary.duplicates > 0) {
      _toast(summary.duplicates === 1
        ? 'Dropped 1 duplicate queued text'
        : ('Dropped ' + summary.duplicates + ' duplicate queued texts'), 'info');
    }
  }

  // ── Explicit actions (the tray) ───────────────────────────────────────

  async function _find(id) {
    const uid = _uid();
    if (!uid) return { uid: null, rec: null };
    const rows = await list(uid);
    return { uid: uid, rec: rows.find((r) => r.id === id) || null };
  }

  /**
   * The rep tapped "Send now" (or "Send anyway" with { activity: true }).
   * An explicit tap is the review the 15-minute rule asks for, so it always
   * carries overrideStale; "Send anyway" adds overrideActivity, which the
   * server honours only for recent_outbound / recent_inbound / lead_changed.
   * Opt-out, quiet hours and idempotency still apply.
   */
  async function sendNow(id, opts) {
    const found = await _find(id).catch(() => ({ rec: null }));
    const rec = found.rec;
    if (!rec || !(rec.status === 'held' || rec.status === 'queued')) return { outcome: 'noop' };
    // A text that may already have gone is never re-sent from a tap: the
    // server claim that would have stopped it may have been released since.
    // Ask instead (the tray offers only "Check again" for these).
    if (_maybeGone(rec)) return checkAgain(id);
    if (!window.NBDComms || typeof window.NBDComms.sendQueued !== 'function') return { outcome: 'noop' };
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      _toast('Still offline — the text stays in Pending texts.', 'warning');
      return { outcome: 'network' };
    }
    const overrides = { stale: true };
    if (opts && opts.activity === true) overrides.activity = true;
    const summary = { sent: 0, held: 0, duplicates: 0, optedOut: 0, stoppedBy: null };
    const step = await _sendOne(rec, found.uid,
      (cur) => cur.status === 'held' || cur.status === 'queued', overrides, summary, true);
    if (summary.sent) _toast('Text sent', 'success');
    else if (summary.held) {
      const after = await _find(id).catch(() => ({ rec: null }));
      const why = after.rec ? _reasonText(after.rec) : 'held';
      _toast('Not sent — ' + why + '.', 'warning');
    } else if (summary.stoppedBy) {
      _toast(summary.stoppedBy === 'auth'
        ? 'Sign in again to send texts — it stays in Pending texts.'
        : 'Could not reach the server — the text stays in Pending texts.', 'warning');
    } else if (step === 'skipped') {
      _toast('That text is already being sent.', 'info');
    }
    _changed();
    return { outcome: step, summary: summary };
  }

  /**
   * "Check again" on a text that may already have gone (held 'in_flight', or
   * a tap whose answer never came back). A PEEK: the server reads the claims
   * and answers — it never sends, whatever it finds and however old the text
   * is. The tap is consent to check, not to send: the rep was told to look at
   * the conversation first, and may have texted from their own phone, which
   * no server check can see.
   *   went out       → recorded as sent (its receipt stamps the invoice)
   *   still unknown  → stays "May already have gone"
   *   did not go     → an ordinary hold that needs an explicit Send now
   */
  async function checkAgain(id) {
    const found = await _find(id).catch(() => ({ rec: null }));
    const rec = found.rec;
    if (!rec || !_maybeGone(rec)) return { outcome: 'noop' };
    if (!window.NBDComms || typeof window.NBDComms.peekQueued !== 'function') return { outcome: 'noop' };
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      _toast('Still offline — the text stays in Pending texts.', 'warning');
      return { outcome: 'network' };
    }
    const summary = { sent: 0, held: 0, duplicates: 0, optedOut: 0, stoppedBy: null, last: null };
    const step = await _peekOne(rec, found.uid, summary);
    if (summary.sent) _toast('It went out — nothing more to send.', 'success');
    else if (summary.peeked === 'in_flight') _toast('Still can\'t tell whether it went — check the conversation before sending it again.', 'warning');
    else if (summary.peeked === 'not_claimed') _toast('It did not go out. Review it, then tap Send now.', 'info');
    else if (summary.peeked) {
      const after = await _find(id).catch(() => ({ rec: null }));
      _toast('Not sent — ' + (after.rec ? _reasonText(after.rec) : 'held') + '.', 'warning');
    } else if (summary.stoppedBy) {
      _toast(summary.stoppedBy === 'auth'
        ? 'Sign in again to check texts — it stays in Pending texts.'
        : 'Could not reach the server — the text stays in Pending texts.', 'warning');
    }
    _changed();
    return { outcome: step, summary: summary };
  }

  /** The rep discards a pending text: it is removed, not sent. */
  async function discard(id) {
    const uid = _uid();
    if (!uid) return false;
    let ok = false;
    try { ok = await _remove(id, uid); } catch (_) { ok = false; }
    _changed();
    return ok;
  }

  /**
   * Edit the message and send it. A NEW client message id — the edited text
   * is a different text — but the ORIGINAL queue time, so activity since the
   * rep first wrote it is still checked. The edit also names the id(s) it
   * replaces (`supersedes`): if one of them reached Twilio after all, the
   * server holds the edit instead of texting the homeowner a second time.
   */
  async function editAndSend(id, newBody) {
    const body = typeof newBody === 'string' ? newBody : '';
    if (!body.trim()) { _toast('Message is empty.', 'error'); return { outcome: 'noop' }; }
    const uid = _uid();
    if (!uid) return { outcome: 'noop' };
    const newId = _newId();
    let edited = null;
    try {
      edited = await _run('readwrite', (store, done) => {
        const r = store.get(id);
        r.onsuccess = () => {
          const cur = r.result;
          if (!cur || cur.uid !== uid || !(cur.status === 'held' || cur.status === 'queued')) { done(null); return; }
          // Not a text that may already have gone: a new id for the same
          // conversation is how a double text happens. "Check again" first.
          if (_maybeGone(cur)) { done(null); return; }
          const next = Object.assign({}, cur, {
            id: newId, body: body, status: 'held', editedAt: _now(), updatedAt: _now(),
            supersedes: (Array.isArray(cur.supersedes) ? cur.supersedes : []).concat([cur.id]).slice(-MAX_SUPERSEDES),
            // Attempts belong to an id; the new id has none yet.
            attempts: 0, uncertain: false, overrides: {},
          });
          store.delete(id);
          store.add(next);
          done(next);
        };
      });
    } catch (_) { edited = null; }
    if (!edited) { _changed(); return { outcome: 'noop' }; }
    return sendNow(newId);
  }

  /**
   * Hand a held text to the device Messages app — an explicit tap only, never
   * from flush(), and never on the strength of the stored hold. The stored
   * 402 / 429 / provider_error may be days old: since then the homeowner may
   * have replied STOP (the register is global per number), texted back, or it
   * may be 11pm. So the tap first re-sends the text (queued: true, the tap's
   * overrideStale only — never overrideActivity), and the handoff happens only
   * if THAT answer is again 402 / 429 / provider_error, which the server gives
   * only after opt-out, quiet hours and the activity checks passed in the
   * same request. Any other answer is applied as usual (sent → done, held →
   * the new reason, opted out → discarded, no network → nothing changes).
   * Once handed off the text leaves the queue: it now lives in Messages. A
   * text with a source + sourceRef (an invoice, a deal, a portal share)
   * leaves a RECEIPT (via 'handoff') instead of just vanishing, so its caller
   * stamps it exactly as it stamps a live handoff (mode 'sms') — otherwise
   * the invoice stayed draft after the homeowner had the text, and invited a
   * second one.
   */
  async function openInMessages(id) {
    const found = await _find(id).catch(() => ({ rec: null }));
    const rec = found.rec;
    if (!rec || rec.status !== 'held' || !HANDOFF_OK[rec.heldReason] || _maybeGone(rec)) return false;
    if (!window.NBDComms || typeof window.NBDComms.sendQueued !== 'function') return false;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      _toast('Still offline — the text stays in Pending texts.', 'warning');
      return false;
    }
    const summary = { sent: 0, held: 0, duplicates: 0, optedOut: 0, stoppedBy: null, last: null };
    const step = await _sendOne(rec, found.uid, (cur) => cur.status === 'held' && !!HANDOFF_OK[cur.heldReason] && !_maybeGone(cur),
      { stale: true }, summary, true);
    const fresh = summary.last;
    if (step === 'skipped') { _toast('That text is already being sent.', 'info'); _changed(); return false; }
    if (!(fresh && fresh.outcome === 'held' && HANDOFF_OK[fresh.reason])) {
      // Not a handoff verdict. Tell the rep what the server said instead.
      if (summary.sent) _toast('Text sent', 'success');
      else if (summary.held) {
        const after = await _find(id).catch(() => ({ rec: null }));
        _toast('Not sent — ' + (after.rec ? _reasonText(after.rec) : 'held') + '.', 'warning');
      } else if (summary.stoppedBy) {
        _toast(summary.stoppedBy === 'auth'
          ? 'Sign in again to send texts — it stays in Pending texts.'
          : 'Could not reach the server — the text stays in Pending texts.', 'warning');
      }
      _changed();
      return false;
    }
    const href = 'sms:' + encodeURIComponent(rec.to) + '?body=' + encodeURIComponent(rec.body || '');
    try {
      const a = document.createElement('a');
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { try { a.remove(); } catch (_) {} }, 0);
    } catch (_) {
      try { window.location.href = href; } catch (__) {}
    }
    if (_isReceipt(rec)) {
      // (the fresh answer left it 'held' with the handoff reason)
      await _recordSent(rec, found.uid, { outcome: 'handoff' }, { from: 'held', via: 'handoff' });
    } else {
      await _remove(rec.id, found.uid).catch(() => false);
    }
    _toast('Opened in Messages — send it from there.', 'info');
    _changed();
    return true;
  }

  // ── Tray UI ───────────────────────────────────────────────────────────
  const PILL_ID = 'nbd-sms-outbox-pill';
  const MODAL_ID = 'nbd-sms-outbox-modal';
  let _renderQueued = false;
  let _bc = null;

  function _mask(toDigits) {
    const d = String(toDigits || '');
    return d.length >= 4 ? '(•••) •••-' + d.slice(-4) : '•••';
  }

  function _age(ms) {
    const s = Math.max(0, Math.round((_now() - ms) / 1000));
    if (s < 60) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return m + ' min ago';
    const h = Math.round(m / 60);
    if (h < 24) return h + ' h ago';
    return Math.round(h / 24) + ' d ago';
  }

  function _reasonText(r, behind) {
    if (r.status === 'discarded') return REASON_TEXT[r.heldReason] || 'Not sent';
    if (r.status === 'sending') return REASON_TEXT.sending;
    if (r.status === 'queued') return behind ? REASON_TEXT.queued_behind : REASON_TEXT.queued;
    // A tap whose answer never came back: whatever it was held for before,
    // it may be on the homeowner's phone now.
    if (_maybeGone(r)) return REASON_TEXT.in_flight;
    return REASON_TEXT[r.heldReason] || REASON_TEXT.error;
  }

  function _ensureCss() {
    if (document.getElementById('nbd-sms-outbox-css')) return;
    const css = document.createElement('style');
    css.id = 'nbd-sms-outbox-css';
    // z: --z-fab — a floating control, UNDER overlays, toasts and the status
    // strips (dashboard-app.css z-scale). Bottom-LEFT, clear of the FAB rail
    // and the bottom-right toasts; rides above bottom strips via
    // --nbd-bottom-chrome and above #mobile-nav via --nbd-sms-pill-lift.
    css.textContent =
      '.nbd-sms-outbox-pill{position:fixed;left:calc(16px + env(safe-area-inset-left,0px));' +
      'bottom:calc(16px + var(--nbd-bottom-chrome,0px) + var(--nbd-sms-pill-lift,0px) + env(safe-area-inset-bottom,0px));' +
      'z-index:var(--z-fab,9900);display:none;align-items:center;gap:6px;min-height:36px;padding:8px 14px;' +
      'border-radius:999px;border:1px solid var(--gold,#D4A017);background:var(--s2,#1a1d23);color:var(--t,#e8eaf0);' +
      'font:inherit;font-size:13px;font-weight:600;box-shadow:0 6px 18px rgba(0,0,0,.35);cursor:pointer;}' +
      '.nbd-sms-outbox-pill.is-visible{display:inline-flex;}' +
      '.nbd-sms-outbox-pill:focus-visible{outline:2px solid var(--gold,#D4A017);outline-offset:2px;}' +
      '#' + MODAL_ID + ' .modal{max-width:520px;width:100%;max-height:80vh;overflow:auto;}' +
      '.nbd-sms-ob-sub{font-size:12px;color:var(--m,#9aa3b2);margin:0 0 12px;line-height:1.45;}' +
      '.nbd-sms-ob-row{border:1px solid var(--br,rgba(255,255,255,.08));border-radius:8px;padding:10px 12px;margin-bottom:8px;}' +
      '.nbd-sms-ob-top{display:flex;justify-content:space-between;gap:8px;font-size:12px;color:var(--m,#9aa3b2);}' +
      '.nbd-sms-ob-to{font-weight:700;color:var(--t,#e8eaf0);}' +
      '.nbd-sms-ob-body{font-size:13px;color:var(--t,#e8eaf0);margin:6px 0;white-space:pre-wrap;word-break:break-word;}' +
      '.nbd-sms-ob-reason{font-size:12px;font-weight:600;color:var(--gold,#D4A017);margin-bottom:8px;}' +
      '.nbd-sms-ob-row.is-discarded .nbd-sms-ob-reason{color:var(--red,#E05252);}' +
      '.nbd-sms-ob-actions{display:flex;flex-wrap:wrap;gap:6px;}' +
      '.nbd-sms-ob-edit{width:100%;min-height:72px;margin:6px 0;box-sizing:border-box;font:inherit;font-size:13px;' +
      'background:var(--s,#111);color:var(--t,#e8eaf0);border:1px solid var(--br,rgba(255,255,255,.12));border-radius:6px;padding:8px;}' +
      '.nbd-sms-ob-empty{font-size:13px;color:var(--m,#9aa3b2);padding:12px 0;}' +
      '.nbd-sms-ob-foot{display:flex;justify-content:flex-end;margin-top:12px;}';
    (document.head || document.body).appendChild(css);
  }

  function _pill() {
    let el = document.getElementById(PILL_ID);
    if (el) return el;
    if (!document.body) return null;
    _ensureCss();
    el = document.createElement('button');
    el.type = 'button';
    el.id = PILL_ID;
    el.className = 'nbd-sms-outbox-pill';
    el.setAttribute('data-sms-outbox-action', 'open');
    el.setAttribute('aria-haspopup', 'dialog');
    document.body.appendChild(el);
    return el;
  }

  function _hidePill() {
    const el = document.getElementById(PILL_ID);
    if (el) el.classList.remove('is-visible');
  }

  function _liftForMobileNav(pill) {
    // #mobile-nav is fixed at bottom:0 on the dashboard's phone layout. Its
    // own module owns it; read its box, never write to it.
    let lift = 0;
    try {
      const nav = document.getElementById('mobile-nav');
      if (nav && nav.getClientRects().length) {
        const r = nav.getBoundingClientRect();
        const vh = window.innerHeight || 0;
        if (r.height > 0 && r.height < 200 && (!vh || r.bottom >= vh - 2)) lift = Math.ceil(r.height);
      }
    } catch (_) {}
    pill.style.setProperty('--nbd-sms-pill-lift', lift + 'px');
  }

  async function _renderPill() {
    const uid = _uid();
    if (!uid) { _hidePill(); return; }
    const n = await pendingCount(uid);
    if (!n) { _hidePill(); return; }
    const pill = _pill();
    if (!pill) return;
    pill.textContent = 'Pending texts (' + n + ')';
    pill.setAttribute('aria-label', n + ' text' + (n === 1 ? '' : 's') + ' waiting to send — review');
    _liftForMobileNav(pill);
    pill.classList.add('is-visible');
  }

  function _changed() {
    if (_bc) { try { _bc.postMessage('changed'); } catch (_) {} }
    _scheduleRender();
  }

  function _scheduleRender() {
    if (_renderQueued) return;
    _renderQueued = true;
    setTimeout(() => {
      _renderQueued = false;
      _renderPill().catch(() => {});
      const m = document.getElementById(MODAL_ID);
      if (m && m.classList.contains('open')) _renderTray().catch(() => {});
    }, 0);
  }

  function _modal() {
    let bg = document.getElementById(MODAL_ID);
    if (bg) return bg;
    _ensureCss();
    bg = document.createElement('div');
    bg.className = 'modal-bg';
    bg.id = MODAL_ID;
    const card = document.createElement('div');
    // Both card contracts: dashboard-app.css styles `.modal`, customer.html
    // styles `.modal-content` (and has no `.modal` rule) — with one class the
    // card had no background, border or padding on the customer page.
    card.className = 'modal modal-content';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', MODAL_ID + '-title');
    const h = document.createElement('h3');
    h.id = MODAL_ID + '-title';
    h.textContent = 'Pending texts';
    h.style.cssText = 'font-family:\'Barlow Condensed\',sans-serif;font-size:18px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;margin:0 0 6px;';
    const sub = document.createElement('p');
    sub.className = 'nbd-sms-ob-sub';
    sub.textContent = 'Texts you wrote while offline. They send on their own only if they are under 15 minutes old, it is 8am–9pm Eastern, and nothing changed since. Everything else waits for you here.';
    const listEl = document.createElement('div');
    listEl.className = 'nbd-sms-ob-list';
    const foot = document.createElement('div');
    foot.className = 'nbd-sms-ob-foot';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'btn btn-ghost';
    close.textContent = 'Close';
    close.setAttribute('data-sms-outbox-action', 'close');
    foot.appendChild(close);
    card.appendChild(h);
    card.appendChild(sub);
    card.appendChild(listEl);
    card.appendChild(foot);
    bg.appendChild(card);
    document.body.appendChild(bg);
    return bg;
  }

  function _btn(label, action, id, cls) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-sm ' + (cls || 'btn-ghost');
    b.textContent = label;
    b.setAttribute('data-sms-outbox-action', action);
    b.setAttribute('data-sms-outbox-id', id);
    return b;
  }

  function _actionsFor(r) {
    if (r.status === 'sending') return [];
    if (r.status === 'discarded') return [['Dismiss', 'discard', 'btn-ghost']];
    if (r.status === 'queued') return [['Send now', 'send', 'btn-orange'], ['Discard', 'discard', 'btn-ghost']];
    const reason = r.heldReason;
    // It may already be on the homeowner's phone — held 'in_flight', or a
    // tap whose answer never came back (`uncertain`, whatever the old hold
    // was). "Check again" PEEKS at THIS id (checkAgain: it never sends); no
    // Send now, and no Edit — a new id for the same words is how a double
    // text happens.
    if (_maybeGone(r)) return [['Check again', 'check', 'btn-ghost'], ['Discard', 'discard', 'btn-ghost']];
    if (reason === 'lead_gone') return [['Discard', 'discard', 'btn-ghost']];
    if (ACTIVITY_HOLDS[reason]) {
      return [['Send anyway', 'send-anyway', 'btn-orange'], ['Edit', 'edit', 'btn-ghost'], ['Discard', 'discard', 'btn-ghost']];
    }
    if (HANDOFF_OK[reason]) {
      return [['Send now', 'send', 'btn-orange'], ['Open in Messages', 'handoff', 'btn-ghost'], ['Discard', 'discard', 'btn-ghost']];
    }
    return [['Send now', 'send', 'btn-orange'], ['Edit', 'edit', 'btn-ghost'], ['Discard', 'discard', 'btn-ghost']];
  }

  async function _renderTray() {
    const bg = _modal();
    const listEl = bg.querySelector('.nbd-sms-ob-list');
    let rows;
    try { rows = await list(); }
    catch (_) {
      listEl.textContent = '';
      const p = document.createElement('div');
      p.className = 'nbd-sms-ob-empty';
      p.textContent = 'Could not read pending texts on this device.';
      listEl.appendChild(p);
      return;
    }
    listEl.textContent = '';
    if (!rows.length) {
      const p = document.createElement('div');
      p.className = 'nbd-sms-ob-empty';
      p.textContent = 'Nothing waiting to send.';
      listEl.appendChild(p);
      return;
    }
    const pendingAhead = {};
    rows.forEach((r) => {
      const behind = r.status === 'queued' && !!pendingAhead[r.toDigits];
      if (ACTIVE[r.status]) pendingAhead[r.toDigits] = true;
      const row = document.createElement('div');
      row.className = 'nbd-sms-ob-row' + (r.status === 'discarded' ? ' is-discarded' : '');
      row.setAttribute('data-sms-outbox-row', r.id);
      const top = document.createElement('div');
      top.className = 'nbd-sms-ob-top';
      const to = document.createElement('span');
      to.className = 'nbd-sms-ob-to';
      to.textContent = _mask(r.toDigits);
      const age = document.createElement('span');
      age.textContent = _age(r.createdAt);
      top.appendChild(to);
      top.appendChild(age);
      const body = document.createElement('div');
      body.className = 'nbd-sms-ob-body';
      const text = String(r.body || '');
      body.textContent = text.length > 80 ? text.slice(0, 80) + '…' : text;
      const reason = document.createElement('div');
      reason.className = 'nbd-sms-ob-reason';
      reason.textContent = _reasonText(r, behind);
      const actions = document.createElement('div');
      actions.className = 'nbd-sms-ob-actions';
      _actionsFor(r).forEach((a) => actions.appendChild(_btn(a[0], a[1], r.id, a[2])));
      row.appendChild(top);
      row.appendChild(body);
      row.appendChild(reason);
      row.appendChild(actions);
      listEl.appendChild(row);
    });
  }

  function _openEditor(id) {
    const bg = document.getElementById(MODAL_ID);
    if (!bg) return;
    const row = bg.querySelector('[data-sms-outbox-row="' + String(id).replace(/["\\]/g, '') + '"]');
    if (!row || row.querySelector('.nbd-sms-ob-edit')) return;
    list().then((rows) => {
      const rec = rows.find((r) => r.id === id);
      if (!rec) return;
      const ta = document.createElement('textarea');
      ta.className = 'nbd-sms-ob-edit';
      ta.value = rec.body || '';
      ta.maxLength = 1600;
      ta.setAttribute('aria-label', 'Edit message');
      const actions = row.querySelector('.nbd-sms-ob-actions');
      row.insertBefore(ta, actions);
      actions.textContent = '';
      actions.appendChild(_btn('Save & send', 'edit-send', id, 'btn-orange'));
      actions.appendChild(_btn('Cancel', 'edit-cancel', id, 'btn-ghost'));
      try { ta.focus(); } catch (_) {}
    }).catch(() => {});
  }

  function openTray() {
    const bg = _modal();
    _renderTray().catch(() => {});
    if (window.nbdModal && typeof window.nbdModal.open === 'function') window.nbdModal.open(bg);
    else bg.classList.add('open');
  }

  function _closeTray() {
    const bg = document.getElementById(MODAL_ID);
    if (!bg) return;
    if (window.nbdModal && typeof window.nbdModal.close === 'function') window.nbdModal.close(bg);
    else bg.classList.remove('open');
  }

  // One delegated listener for the pill and every tray control (CSP).
  document.addEventListener('click', (ev) => {
    const t = ev.target && ev.target.closest && ev.target.closest('[data-sms-outbox-action]');
    if (!t) return;
    const action = t.getAttribute('data-sms-outbox-action');
    const id = t.getAttribute('data-sms-outbox-id');
    if (action === 'open') { openTray(); return; }
    if (action === 'close') { _closeTray(); return; }
    if (!id) return;
    const busy = (p) => {
      t.disabled = true;
      Promise.resolve(p).catch(() => {}).then(() => { try { t.disabled = false; } catch (_) {} _scheduleRender(); });
    };
    if (action === 'send') busy(sendNow(id));
    else if (action === 'check') busy(checkAgain(id));
    else if (action === 'send-anyway') busy(sendNow(id, { activity: true }));
    else if (action === 'discard') busy(discard(id));
    else if (action === 'handoff') busy(openInMessages(id));
    else if (action === 'edit') _openEditor(id);
    else if (action === 'edit-cancel') _scheduleRender();
    else if (action === 'edit-send') {
      const row = t.closest('[data-sms-outbox-row]');
      const ta = row && row.querySelector('.nbd-sms-ob-edit');
      busy(editAndSend(id, ta ? ta.value : ''));
    }
  });

  // ── Boot ──────────────────────────────────────────────────────────────
  // Auth resolves after boot; poll for a real user like photo-queue-recovery.js
  // does, and give up quietly (a signed-out page never flushes).
  function _waitForUser() {
    if (_uid()) return Promise.resolve(_uid());
    return new Promise((resolve) => {
      const started = _now();
      const timer = setInterval(() => {
        const u = _uid();
        if (u) { clearInterval(timer); resolve(u); return; }
        if (_now() - started > 60000) { clearInterval(timer); resolve(null); }
      }, 500);
    });
  }

  // Backstop for every sign-out path this module does not know about (the
  // named ones — nbd-auth.js logout, the dashboard's _signOut, the command
  // palette — purge before signOut): when the page's Firebase Auth reports
  // NO user after having had one — signed out here, or in another tab — the
  // store is purged. Only on that transition: a page that never had a user
  // (still booting) purges nothing.
  let _authWatched = false;
  function _watchAuthDrop() {
    if (_authWatched) return;
    const a = window.auth || window._auth || null;
    if (!a || typeof a.onAuthStateChanged !== 'function') return;
    _authWatched = true;
    let seen = !!_uid();
    try {
      a.onAuthStateChanged((u) => {
        if (u && u.uid) { seen = true; return; }
        if (!seen) return;
        seen = false;
        _lastUid = null;
        purgeAll().catch(() => false);
      });
    } catch (_) { _authWatched = false; }
  }

  function _boot() {
    try {
      if (typeof BroadcastChannel === 'function') {
        _bc = new BroadcastChannel('nbd-sms-outbox');
        // Another tab changed the store: repaint, and apply any receipt it
        // left that a handler in THIS tab can stamp.
        _bc.onmessage = () => { _scheduleRender(); _drainReceipts(); };
      }
    } catch (_) { _bc = null; }
    window.addEventListener('online', () => { flush('online'); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') flush('visible');
    });
    _watchAuthDrop();
    _waitForUser().then(async (uid) => {
      if (!uid) return;
      _watchAuthDrop();
      // Account switch on a shared device: another account's texts are
      // deleted before anything is shown or sent — even while offline, when
      // flush() below returns early.
      try { await _purgeOtherUsers(uid); _lastUid = uid; } catch (_) {}
      _scheduleRender();
      _drainReceipts();
      flush('load');
    });
  }

  window.NBDSmsOutbox = {
    enqueue: enqueue,
    list: list,
    pendingCount: pendingCount,
    flush: flush,
    sendNow: sendNow,
    checkAgain: checkAgain,
    discard: discard,
    editAndSend: editAndSend,
    openInMessages: openInMessages,
    openTray: openTray,
    purgeAll: purgeAll,
    onSent: onSent,
    // nbd-comms.js mints the live attempt's clientMsgId with this, so a text
    // queued after that attempt keeps the id the server may have claimed.
    newId: _newId,
    // Pure helpers the tray renders with; exposed for tests/sms-outbox-client.test.js.
    _internals: { actionsFor: _actionsFor, mask: _mask, reasonText: _reasonText },
    MAX_PER_USER: MAX_PER_USER,
    STALE_MS: STALE_MS,
    DB_NAME: DB_NAME,
    DB_STORE: DB_STORE,
  };

  _boot();

  // Consumers that loaded BEFORE this file (dashboard.html loads
  // portal-link-helpers.js earlier) wait for this to call onSent().
  try { window.dispatchEvent(new CustomEvent('nbd:sms-outbox-ready')); } catch (_) {}
})();
