/**
 * NBD Pro — Close Board v1
 * Customer-facing shareable deal rooms
 * Generate unique estimate links → homeowner views tiers, signs, schedules
 * Stores deal room data in Firestore, generates standalone HTML for sharing
 */

(function() {
  'use strict';

  // ============================================================================
  // CONSTANTS
  // ============================================================================

  const DEAL_COLLECTION = 'deal_rooms';
  // Per-account key prefix: rows live under 'nbd_deal_rooms:<uid>' (see
  // STORAGE). The bare prefix is the pre-2026-09-18 device-global key, read
  // once to migrate and then removed. Keep the 'nbd_' prefix: it is what puts
  // these keys on NBDAuth.purgeAccountStorage()'s sign-out / account-switch
  // purge (tests/close-board-per-uid-storage-2026-09-18.test.js runs it).
  const DEAL_STORAGE_KEY = 'nbd_deal_rooms';
  const FINANCING_RATES = [
    { term: 12, rate: 0, label: '12 mo Same-as-Cash' },
    { term: 36, rate: 5.99, label: '36 mo @ 5.99%' },
    { term: 60, rate: 7.99, label: '60 mo @ 7.99%' },
    { term: 120, rate: 9.99, label: '120 mo @ 9.99%' },
    { term: 180, rate: 11.99, label: '180 mo @ 11.99%' }
  ];

  const DEAL_STATUS = {
    DRAFT: 'draft',
    SENT: 'sent',
    VIEWED: 'viewed',
    ACCEPTED: 'accepted',
    SIGNED: 'signed',
    SCHEDULED: 'scheduled',
    EXPIRED: 'expired'
  };

  const STATUS_COLORS = {
    draft: 'var(--m)',
    sent: 'var(--blue)',
    viewed: '#ffab00',
    accepted: 'var(--green)',
    signed: '#2ECC8A',
    scheduled: 'var(--orange)',
    expired: 'var(--red)'
  };

  // Customer-facing tier name (GBB audit, 2026-09-09: this deal room is what
  // a homeowner actually opens and signs from — it must show the marketed
  // name, not the internal good/better/best jargon). Reads the single source
  // of truth in estimate-config.js when loaded (always true on dashboard.html,
  // where deals are created); the inline fallback matches it exactly in case
  // this ever runs before that script, per this file's own established
  // "config may fail to load" pattern.
  function tierDisplayLabel(key) {
    const cfg = window.NBD_ESTIMATE_CONFIG;
    if (cfg && typeof cfg.tierLabel === 'function') return cfg.tierLabel(key);
    return ({ economy: 'Economy', good: 'Standard', better: 'Preferred', best: 'Elite', beyond: 'Beyond' })[key] || key;
  }
  // Five tiers, cheapest first (estimate-config.js TIER_ORDER, 2026-10-02).
  function dealTiers() {
    const cfg = window.NBD_ESTIMATE_CONFIG;
    return (cfg && Array.isArray(cfg.TIER_ORDER)) ? cfg.TIER_ORDER.slice() : ['economy', 'good', 'better', 'best', 'beyond'];
  }

  // Per-tier warranty differentiator (all tiers are lifetime workmanship —
  // see the flat warranty badge above — so this is just what varies:
  // transferability + inspection). Same config, same fallback pattern.
  function tierDisplayWarrantyBlurb(key) {
    const cfg = window.NBD_ESTIMATE_CONFIG;
    if (cfg && typeof cfg.tierWarrantyBlurb === 'function') return cfg.tierWarrantyBlurb(key);
    return ({ economy: '1-year labor warranty', good: 'Non-transferable', better: 'Transferable to 1 subsequent owner', best: 'Fully transferable + annual inspection', beyond: 'Fully transferable + annual inspection + hail warranty' })[key] || '';
  }

  // Per-tier card copy (2026-09-25). The cards promised scope no tier price
  // buys: Best was "Complete roof system with full deck replacement and
  // gutters", Better "adds ice & water shield, hip caps, pipe boots, partial
  // deck repair". A tier price changes the shingle line, never the scope,
  // and a homeowner signs from this page — so the cards say only that, and
  // the scope is whatever the estimate says. Upgrades (gutters, ice & water,
  // decking) get their own priced lines, never a tier card
  // (documentation/projects/UPGRADES-ADDONS-DESIGN-2026-09-25.md).
  const TIER_DESCRIPTIONS = Object.freeze({
    economy: 'Economy-grade architectural shingle (never a 3-tab). Scope exactly as written in your estimate.',
    good:   'Standard shingle line. Scope exactly as written in your estimate.',
    better: 'Upgraded shingle line. Scope exactly as written in your estimate.',
    best:   'Top shingle line. Scope exactly as written in your estimate.',
    beyond: 'TAMKO HailGuard — the only shingle with a manufacturer hail warranty. Scope exactly as written in your estimate.'
  });
  // An empty { tierKey: {label, price, description, lineItems} } map.
  function blankTiers(priceFor) {
    const out = {};
    dealTiers().forEach(t => {
      out[t] = { label: tierDisplayLabel(t), price: (priceFor ? priceFor(t) : 0) || 0, lineItems: [], description: TIER_DESCRIPTIONS[t] };
    });
    return out;
  }

  // ============================================================================
  // STATE
  // ============================================================================

  let dealRooms = [];
  // The account dealRooms was loaded for, or null before any account is
  // known. dealRooms only ever holds this account's rows and is only ever
  // written back to this account's key.
  let _dealRoomsUid = null;
  let activeDeal = null;
  let currentTab = 'active'; // 'active' | 'create' | 'analytics'

  // ============================================================================
  // HELPERS
  // ============================================================================

  // Quotes too — used in attributes (alt="…"); security audit 2026-09-29.
  function esc(s) { return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function fmtCurrency(n) { return '$' + (n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  // A bare 'YYYY-MM-DD' (the install date) is a local day — new Date() reads it
  // as UTC midnight, which is the evening before in Eastern time.
  function fmtDate(d) {
    if (!d) return '—';
    const ymd = typeof d === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
    const dt = ymd ? new Date(+ymd[1], +ymd[2] - 1, +ymd[3]) : new Date(d);
    return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function timeAgo(d) {
    if (!d) return '';
    const diff = Date.now() - new Date(d).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return mins + 'm ago';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    return Math.floor(hrs / 24) + 'd ago';
  }
  function generateId() { return 'dr_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 6); }

  function calcMonthlyPayment(principal, annualRate, termMonths) {
    if (annualRate === 0) return principal / termMonths;
    const r = annualRate / 100 / 12;
    return principal * r * Math.pow(1 + r, termMonths) / (Math.pow(1 + r, termMonths) - 1);
  }

  // The booked dollar value of a deal. A remote acceptance writes acceptedTier +
  // acceptedPrice (the server's price snapshot, deal-acceptance.js) — NOT
  // selectedTier, which stays null. So reading d.selectedTier silently priced
  // every non-'better' close at the 'better' tier. Prefer the authoritative
  // acceptedPrice, then the accepted tier's current price, then 'better', then 0.
  function dealValue(d) {
    if (!d) return 0;
    const ap = Number(d.acceptedPrice);
    if (d.acceptedPrice != null && !isNaN(ap)) return ap;
    const tierKey = d.acceptedTier || d.selectedTier || 'better';
    return (d.tiers && d.tiers[tierKey] && Number(d.tiers[tierKey].price)) || 0;
  }

  // Closed = the homeowner accepted (or later signed / scheduled). Mirrors the
  // server's DONE_STATUSES (functions/deal-acceptance.js): no new accept link is
  // minted for these, so the card drops Text / Email / Copy.
  // Server-owned fields of a homeowner acceptance (deal-acceptance.js).
  const ACCEPTANCE_KEYS = ['acceptedTier', 'acceptedPrice', 'acceptedFinancing', 'acceptedSignature', 'acceptedAt', 'acceptedVia'];

  function _isClosedDeal(d) {
    return !!(d && [DEAL_STATUS.ACCEPTED, DEAL_STATUS.SIGNED, DEAL_STATUS.SCHEDULED].includes(d.status));
  }

  // Whether the homeowner ever opened the deal link. The server stamps viewedAt
  // (getDealRoom) on first open, then overwrites status to 'accepted' on accept —
  // so status==='viewed' undercounts, and viewCount is never incremented at all.
  // Treat viewedAt OR any post-sent status as evidence of a view.
  function wasViewed(d) {
    return !!(d && (d.viewedAt || d.viewCount > 0 ||
      [DEAL_STATUS.VIEWED, DEAL_STATUS.ACCEPTED, DEAL_STATUS.SIGNED, DEAL_STATUS.SCHEDULED].includes(d.status)));
  }

  // "👁 Viewed 3× · 12 min" (2026-10-02): getDealRoom counts real opens (not
  // link-preview bots) and dealRoomReadPing adds time on page. Older deals
  // have only viewedAt, so they read plain "Viewed".
  function viewBadge(d) {
    const n = Number(d && d.viewCount) || 0;
    const s = Math.floor(Number(d && d.readSeconds) || 0);
    const read = s >= 60 ? Math.round(s / 60) + ' min' : (s > 0 ? s + ' sec' : '');
    return '👁 Viewed' + (n > 1 ? ' ' + n + '×' : '') + (read ? ' · ' + read : '');
  }
  function viewTitle(d) {
    const t = d && d.lastViewedAt;
    const ms = t && typeof t.toMillis === 'function' ? t.toMillis() : (t && t.seconds ? t.seconds * 1000 : 0);
    return ms ? 'Last opened ' + new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Opened';
  }

  // ============================================================================
  // STORAGE
  // ============================================================================

  // Per-account cache (2026-09-18, deferred from the PR #1663 review). Deal
  // rooms used to live under ONE device-global key, so on a shared device the
  // next rep's board listed the previous rep's deals (customer names,
  // addresses, prices) and any edits that had not synced — and could never
  // clear them, because the owner rule refuses B's delete of A's deal. The
  // account-switch purge in dashboard-bootstrap only helps when nbd_last_uid
  // names the prior account, and it never reached this module's in-memory
  // array.
  //
  // Rows now live under 'nbd_deal_rooms:<uid>'. dealRooms is tagged with the
  // account it was loaded for: when a different account is signed in, the
  // board reloads from that account's key, and a save never writes one
  // account's rows under another's key. With no account known, nothing is
  // read — there is no way to tell whose rows they would be.
  function _currentUid() { return (window._user && window._user.uid) || null; }
  function _dealStorageKey(uid) { return DEAL_STORAGE_KEY + ':' + uid; }
  function _parseRows(raw) {
    try {
      const rows = JSON.parse(raw || '[]');
      return Array.isArray(rows) ? rows.filter(d => d && d.id) : [];
    } catch (e) { return []; }
  }

  // The legacy device-global key: hand this account only the rows that
  // provably belong to it. A stamped row (userId, set by a sync or a hydrate)
  // belongs to exactly that account. An unstamped row — a never-synced draft
  // — names its creator only through repEmail (createDealRoom stamps the
  // signed-in rep's email), so it moves only when it names this rep AND
  // nothing on the device points at a second account: no row stamped or
  // created by anyone else, no other account's per-account key. Everything
  // else is dropped with the key. A dropped row that was ever synced is still
  // on the server, and hydrate restores it for its owner; a dropped draft is
  // lost — the same trade the account-switch purge already makes.
  function _legacyRowsFor(uid, raw) {
    const rows = _parseRows(raw);
    const email = String((window._user && window._user.email) || '').trim().toLowerCase();
    const namesMe = (e) => !!email && String(e || '').trim().toLowerCase() === email;
    let otherAccount = rows.some(d => (d.userId && d.userId !== uid) || (d.repEmail && !namesMe(d.repEmail)));
    try {
      for (let i = 0; !otherAccount && i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf(DEAL_STORAGE_KEY + ':') === 0 && k !== _dealStorageKey(uid)) otherAccount = true;
      }
    } catch (e) { otherAccount = true; }
    return rows.filter(d => (d.userId ? d.userId === uid : !otherAccount && namesMe(d.repEmail)));
  }

  function loadDealRooms() {
    const uid = _currentUid();
    _dealRoomsUid = uid;
    dealRooms = [];
    if (!uid) return;
    let stored = [];
    let legacy = null;
    try {
      stored = _parseRows(localStorage.getItem(_dealStorageKey(uid)));
      legacy = localStorage.getItem(DEAL_STORAGE_KEY);
    } catch (e) { /* storage unavailable: an empty board, never someone else's */ }
    // A row stamped for another account never belongs in this one's cache.
    dealRooms = stored.filter(d => !d.userId || d.userId === uid);
    if (legacy != null) {
      const have = new Set(dealRooms.map(d => d.id));
      _legacyRowsFor(uid, legacy).forEach(d => { if (!have.has(d.id)) { have.add(d.id); dealRooms.push(d); } });
    }
    // Persist the migration / the purge. The legacy key goes only once this
    // account's rows are safely under its own key; a failed write leaves it
    // for the next load to retry.
    if ((legacy != null || dealRooms.length !== stored.length) && saveDealRooms() && legacy != null) {
      try { localStorage.removeItem(DEAL_STORAGE_KEY); } catch (e) { /* retried next load */ }
    }
  }

  // Writes dealRooms to the key of the account it was loaded for — never to
  // whoever is signed in now, if that is a different account. Returns whether
  // the write landed.
  function saveDealRooms() {
    const uid = _currentUid();
    if (!_dealRoomsUid || (uid && uid !== _dealRoomsUid)) return false;
    try { localStorage.setItem(_dealStorageKey(_dealRoomsUid), JSON.stringify(dealRooms)); return true; }
    catch (e) { console.error('Deal rooms save error:', e); return false; }
  }

  // Every entry point reads deals through this: when a different account is
  // signed in than the one dealRooms holds (a same-tab account switch, or the
  // first call after auth resolved), reload from that account's key first.
  function _dealRoomsForCurrentUser() {
    const uid = _currentUid();
    if (uid && uid !== _dealRoomsUid) loadDealRooms();
    return dealRooms;
  }
  function _findDeal(dealId) { return _dealRoomsForCurrentUser().find(d => d.id === dealId); }

  // Also save to Firestore if available.
  //
  // A delete wins over a sync (2026-09-22, a #1663 residual). updateDeal
  // fires this without awaiting it, and the write is only ISSUED after the
  // SDK import resolves. Firestore applies a client's writes in the order
  // they are issued, so a sync whose setDoc was issued before deleteDeal's
  // deleteDoc is harmless (the delete lands last). But a sync still waiting
  // on the import when the rep deleted the deal — or one fired by an edit or
  // a send while the delete was in flight — issued setDoc(merge) AFTER the
  // deleteDoc, and setDoc(merge) creates a missing doc: the deal came back
  // on the next hydrate, and because deleteDeal does not burn the
  // deal_accept_tokens, the homeowner's /deal/<token> link became acceptable
  // again. Two guards, both checked right before the write with no await in
  // between (so the issue order is what they judge):
  //   1. An id this tab is deleting (in flight) or has deleted is not
  //      written. A sync held back by an in-flight delete is replayed only
  //      if that delete fails (the deal stays, and so must its edit).
  //   2. A deal the server has confirmed (userId stamped by an acked write or
  //      by hydrate) is written with updateDoc, which fails on a missing doc,
  //      instead of setDoc(merge), which recreates it — so a deal deleted on
  //      ANOTHER device cannot be brought back by a stale edit here either.
  //      Only an unconfirmed deal (the first save, or a retry of one) uses
  //      setDoc(merge), since creating the doc is what that write is for.
  // Resolves true when the write landed.
  function _dealIsGone(id) { return _dealDeletesInFlight.has(id) || _dealsDeletedHere.has(id); }
  async function syncDealToFirestore(deal) {
    if (!window._db || !window._user) return false;
    try {
      const { setDoc, updateDoc, doc } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      const uid = window._user.uid;
      // Checked AFTER the import await, with nothing awaited between it and
      // the write: that await is the window the race lived in.
      if (_dealIsGone(deal.id)) {
        if (_dealDeletesInFlight.has(deal.id)) _dealSyncsHeldForDelete.add(deal.id);
        return false;
      }
      const ref = doc(window._db, DEAL_COLLECTION, deal.id);
      const data = {
        ...deal,
        userId: uid,
        companyId: window._userClaims?.companyId || uid,
        updatedAt: new Date().toISOString()
      };
      // The homeowner's acceptance is server-written (deal-acceptance.js) and
      // locked by firestore.rules once the deal closes. Never echo it back:
      // after a reload the local copy holds acceptedAt as a plain
      // {seconds, nanoseconds} map, and writing that would be a change.
      ACCEPTANCE_KEYS.forEach(k => { delete data[k]; });
      if (deal.userId === uid) await updateDoc(ref, data);
      else await setDoc(ref, data, { merge: true });
      // The server now holds this deal. Stamp that on the LOCAL copy too:
      // deleteDeal reads deal.userId as "a deal_rooms doc exists", and only
      // such deals must wait for a confirmed server delete (a never-synced
      // draft has nothing server-side to delete). Hydrated deals already carry
      // userId from the remote doc.
      if (deal.userId !== uid) { deal.userId = uid; saveDealRooms(); }
      return true;
    } catch (e) { console.error('Deal Firestore sync error:', e); return false; }
  }

  // Hydrate from Firestore so the board reflects SERVER state — most importantly
  // a REMOTE homeowner acceptance (submitDealAcceptance flips deal_rooms/{id}.
  // status → 'accepted'), and deals created/sent on another device. Without
  // this the board read localStorage only, so a real remote close showed as
  // still-open, Closed Value never moved, and the deal was invisible on any
  // other device. Server is authoritative for the deal lifecycle; local-only
  // drafts (never synced) are preserved. Re-renders when it returns.
  //
  // It is authoritative for REMOVALS too (2026-09-18 review of the
  // server-confirmed delete): a deal this user's server copy once confirmed
  // that a fresh server read no longer returns was deleted elsewhere (another
  // device, or this one in an earlier session), so it is pruned here. Without
  // that, the local copy — which carries userId from an earlier hydrate — sat
  // on the board forever: deleteDeal treats it as on-server, deleteDoc on the
  // missing doc is permission-denied (the owner rule reads userId off a null
  // resource), and it answered "the customer's link is still live" to every
  // tap. deleteDeal must NOT shortcut that case itself: App Check and token
  // failures can surface as permission-denied too.
  //
  // Prune only what (1) was confirmed BEFORE the read started — a sync that
  // lands mid-read stamps userId on a doc the snapshot may predate; (2) this
  // user's query can speak for — another account's row is not in it (the
  // cache is per-account now and loadDealRooms drops rows stamped for another
  // uid, but the query still judges only this uid's); (3) is not being deleted
  // right now — deleteDeal owns it until its delete settles; and only (4) from
  // a SERVER snapshot: offline, getDocs resolves from the local cache, which
  // is no evidence the server lost anything.
  const _dealsDeletedHere = new Set();
  function _isConfirmedBy(d, uid) {
    // deleteDeal's "on the server" test, narrowed to this user's rows: userId
    // stamped by a sync or a hydrate, or a minted acceptUrl on a row that
    // predates the local stamp.
    return !!(d && d.id && (d.userId === uid || (!d.userId && d.acceptUrl)));
  }
  async function hydrateFromFirestore() {
    if (!window._db || !window._user) return;
    const uid = window._user.uid;
    const confirmedBeforeRead = _dealRoomsForCurrentUser().filter(d => _isConfirmedBy(d, uid)).map(d => d.id);
    try {
      const { getDocs, query, collection, where } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      const snap = await getDocs(query(
        collection(window._db, DEAL_COLLECTION),
        where('userId', '==', uid)
      ));
      // The account changed while the read was in flight: this is the
      // previous account's snapshot, and merging it would put their deals on
      // (and under the key of) the account now signed in.
      if (_currentUid() !== uid || _dealRoomsUid !== uid) return;
      const byId = {};
      dealRooms.forEach(d => { if (d && d.id) byId[d.id] = d; });
      const returned = new Set();
      snap.forEach(docSnap => {
        const remote = docSnap.data() || {};
        const id = remote.id || docSnap.id;
        returned.add(id);
        // A read that started before this device's delete landed still has
        // the doc; merging it would resurrect a deal whose link is dead.
        if (_dealsDeletedHere.has(id)) return;
        // Server overrides any local copy (it has the latest status/acceptance);
        // server-only deals get added.
        byId[id] = Object.assign({}, byId[id] || {}, remote, { id });
      });
      let pruned = 0;
      if (snap.metadata && snap.metadata.fromCache === false) {
        confirmedBeforeRead.forEach(id => {
          if (!returned.has(id) && !_dealDeletesInFlight.has(id) && byId[id]) { delete byId[id]; pruned++; }
        });
      }
      if (snap.empty && !pruned) return;
      dealRooms = Object.values(byId);
      saveDealRooms();
      // Don't clobber a rep mid-typing in the New Deal form — hydrate only needs
      // to refresh the active/analytics views (the create tab re-renders to the
      // active list on submit anyway).
      if (currentTab !== 'create') render();
    } catch (e) { console.error('Close Board hydrate error:', e); }
  }

  // ============================================================================
  // DEAL ROOM CRUD
  // ============================================================================

  function _dealLinkDays() {
    const p = window._companyProfile || {};
    const n = Math.floor(Number(p.salesLinks && p.salesLinks.dealLinkDays));
    return Number.isFinite(n) && n > 0 ? Math.min(90, n) : 14;
  }

  function createDealRoom(opts) {
    const deal = {
      id: generateId(),
      status: DEAL_STATUS.DRAFT,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      // Company setting since 2026-10-03 (Settings → Sales links), default 14 —
      // the same number createDealAcceptToken gives the accept link.
      expiresAt: new Date(Date.now() + _dealLinkDays() * 24 * 60 * 60 * 1000).toISOString(),

      // Customer info
      customerName: opts.customerName || '',
      customerEmail: opts.customerEmail || '',
      customerPhone: opts.customerPhone || '',
      address: opts.address || '',

      // Lead reference
      leadId: opts.leadId || null,
      estimateId: opts.estimateId || null,

      // Pricing tiers
      tiers: opts.tiers || blankTiers(),

      // Product details
      selectedProducts: opts.selectedProducts || [],
      shingleColor: opts.shingleColor || '',
      // GBB audit, 2026-09-09: was a flat '25-year limited lifetime' that
      // matched no tier's actual warranty (Sept-8 commit a3ac83b1 flagged
      // this verbatim as "needs a decision, not a guess"). All three tiers
      // now carry the same lifetime workmanship warranty (they always
      // differed only by transferability, never duration), so a single
      // flat badge is finally accurate for every tier — see the per-tier
      // transferability line rendered on each tier card instead.
      warranty: opts.warranty || 'Lifetime Workmanship Warranty',

      // Insurance
      insuranceClaim: opts.insuranceClaim || false,
      insuranceCarrier: opts.insuranceCarrier || '',
      claimNumber: opts.claimNumber || '',
      deductible: opts.deductible || 0,

      // Signature
      signedAt: null,
      signatureData: null,
      selectedTier: null,
      selectedFinancing: null,
      scheduledDate: null,

      // Tracking
      viewCount: 0,
      lastViewedAt: null,
      sentAt: null,
      sentVia: null, // 'sms' | 'email' | 'link'

      // Rep info
      repName: opts.repName || window._user?.displayName || 'Your NBD Rep',
      repPhone: opts.repPhone || '',
      repEmail: opts.repEmail || window._user?.email || '',
      repPhoto: opts.repPhoto || '',

      // Notes
      notes: opts.notes || ''
    };

    // Into the signed-in account's list: after an account switch, dealRooms
    // may still hold the previous account's rows until something reloads it.
    _dealRoomsForCurrentUser().unshift(deal);
    saveDealRooms();
    syncDealToFirestore(deal);
    return deal;
  }

  function updateDeal(dealId, updates) {
    const deal = _findDeal(dealId);
    if (deal) {
      Object.assign(deal, updates, { updatedAt: new Date().toISOString() });
      saveDealRooms();
      syncDealToFirestore(deal);
    }
    return deal;
  }

  // Server-confirmed delete (2026-09-18). This used to filter the deal out of
  // memory + localStorage and re-render FIRST, then try the Firestore delete
  // only if _db/_user were set and swallow any error. When that delete was
  // skipped or failed, the deal_rooms doc survived: hydrateFromFirestore
  // merged it back on the next load and — worse — the homeowner's
  // /deal/<token> link stayed live and acceptable, because getDealRoom and
  // submitDealAcceptance only check that the deal doc exists. So a deal the
  // rep "deleted" could still be signed.
  //
  // Now a deal the server has confirmed disappears only after deleteDoc
  // resolves. "On the server" = deal.userId (stamped by a successful
  // syncDealToFirestore or carried in by hydrate) or deal.acceptUrl
  // (createDealAcceptToken requires the doc, and it means a customer link is
  // live). A never-synced draft may still be removed locally: it has no
  // server doc, the owner rule reads resource.data.userId off a null
  // resource, so deleting it is DENIED — that permission-denied is the
  // expected answer for a draft, not a failure. Offline, deleteDoc stays
  // pending and the deal stays visible, which is the fail-closed outcome.
  // Resolves true when the deal was removed, false when it was kept.
  const _dealDeletesInFlight = new Set();
  // Syncs syncDealToFirestore held back because a delete of that deal was in
  // flight. Replayed when the delete fails (the deal is kept, with its edit);
  // dropped when it succeeds (the edit belonged to a deleted deal).
  const _dealSyncsHeldForDelete = new Set();
  async function deleteDeal(dealId) {
    const deal = _findDeal(dealId);
    if (!deal || _dealDeletesInFlight.has(dealId)) return false;
    // A signed / accepted deal is a record (firestore.rules denies the delete).
    if (_isClosedDeal(deal)) {
      if (window.showToast) window.showToast('A signed deal is kept on record — it can\'t be deleted.', 'info');
      return false;
    }
    const onServer = !!(deal.userId || deal.acceptUrl);
    if (window._db && window._user) {
      if (window.showToast) window.showToast('Deleting…', 'info');
      _dealDeletesInFlight.add(dealId);
      let kept = false;
      try {
        const { deleteDoc, doc } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
        await deleteDoc(doc(window._db, DEAL_COLLECTION, dealId));
      } catch (e) {
        if (onServer || !e || e.code !== 'permission-denied') {
          console.error('Deal delete (Firestore) error:', e);
          if (window.showToast) window.showToast("Could not delete this deal — the customer's link is still live. Check your connection and try again.", 'error');
          kept = true;
          return false;
        }
        // Never-synced draft: no server doc to delete. Safe to drop locally.
      } finally {
        _dealDeletesInFlight.delete(dealId);
        const held = _dealSyncsHeldForDelete.delete(dealId);
        if (kept && held) syncDealToFirestore(deal);
      }
    } else if (onServer) {
      if (window.showToast) window.showToast('Still signing in — try again in a moment. The deal was not deleted.', 'error');
      return false;
    }
    // Filter by the deal's own id AFTER the await, so a concurrent change to
    // dealRooms (hydrate, a second delete) cannot drop the wrong row.
    _dealsDeletedHere.add(deal.id);
    dealRooms = dealRooms.filter(d => d.id !== deal.id);
    saveDealRooms();
    render();
    if (window.showToast) window.showToast('Deal room deleted', 'success');
    return true;
  }

  // Destructive — confirm before removing a deal room from every device.
  // Batch 2 (iOS PWA): native confirm() always returns true in PWA standalone
  // mode (see standalone-compat.js), so on the installed app this guard was
  // auto-answering YES and the deal vanished on the first tap. nbdConfirm
  // returns a real Promise<boolean> via a modal in PWA mode and falls back to
  // native confirm on desktop. Only caller is the delegated data-cb-action
  // dispatcher, which ignores the return value — safe to make async.
  async function confirmDeleteDeal(dealId) {
    const deal = _findDeal(dealId);
    const name = (deal && deal.customerName) || 'this deal';
    const _ask = window.nbdConfirm || ((m) => Promise.resolve(window.confirm(m)));
    if (await _ask('Delete the deal room for ' + name + '?\nThis removes it from all your devices and cannot be undone.')) {
      deleteDeal(dealId);
    }
  }

  // ============================================================================
  // DEAL ROOM FROM ESTIMATE
  // ============================================================================

  function createFromEstimate(estimateData, leadData) {
    // Pull pricing from current estimate
    const tiers = blankTiers(t => estimateData?.prices?.[t]);

    // Pull line items if available
    if (typeof window.getLineItems === 'function') {
      const items = window.getLineItems();
      // One scope for every tier (2026-09-25). These filters used to drop
      // ice & water, hip caps, pipe boots, decking and gutters from the lower
      // tiers — the data twin of the card copy TIER_DESCRIPTIONS replaced. The
      // tier price never removed that scope, so no tier's list may either.
      dealTiers().forEach(t => { tiers[t].lineItems = items.slice(); });
    }

    // Get product names from library
    let selectedProducts = [];
    if (window._productLib) {
      const products = window._productLib.getProducts();
      const shingle = products.find(p => p.id === 'shingle_001');
      if (shingle) selectedProducts.push({ name: shingle.name, manufacturer: shingle.manufacturer });
    }

    // Lead field names as the lead form writes them: firstName/lastName (no
    // `name`), insCarrier, deductibleOrOwedByHO. Reading name/insuranceCarrier/
    // deductible alone made every deal "Unnamed" with no claim details.
    const _nm = ((leadData?.firstName || '') + ' ' + (leadData?.lastName || '')).trim() || leadData?.name || '';
    const _carrier = leadData?.insCarrier || leadData?.insuranceCarrier || '';
    const deal = createDealRoom({
      customerName: _nm,
      customerEmail: leadData?.email || '',
      customerPhone: leadData?.phone || '',
      address: leadData?.address || '',
      leadId: leadData?.id || null,
      tiers,
      selectedProducts,
      insuranceClaim: !!_carrier,
      insuranceCarrier: _carrier,
      claimNumber: leadData?.claimNumber || '',
      deductible: leadData?.deductibleOrOwedByHO || leadData?.deductible || 0
    });

    return deal;
  }

  // ============================================================================
  // SHAREABLE DEAL PAGE GENERATOR
  // ============================================================================

  // Full white-label (2026-07-19): the deal room is generated REP-side, so
  // the tenant brand is baked at generation time via window._brand() (same
  // lazy-gate pattern as photo-report.js). NBD (or unconfigured) keeps every
  // literal byte-identical — incl. the legal authorization sentence, which
  // previously named No Big Deal for EVERY tenant's homeowner.
  function _dealBrand() {
    let b = {};
    try { if (typeof window._brand === 'function') b = window._brand() || {}; } catch (_) {}
    const isNbd = !b.legalName || b.legalName === 'No Big Deal Home Solutions';
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const logo = (!isNbd && typeof b.logoUrl === 'string' && /^https:\/\//i.test(b.logoUrl)) ? b.logoUrl : '';
    const accent = (!isNbd && b.colors && /^#[0-9a-f]{3,8}$/i.test(b.colors.accent || '')) ? b.colors.accent : '#BD5728';
    return {
      isNbd,
      name: isNbd ? 'No Big Deal Home Solutions' : b.legalName,
      nameEsc: isNbd ? 'No Big Deal Home Solutions' : esc(b.legalName),
      logoHtml: isNbd
        ? 'NO BIG DEAL <span>HOME SOLUTIONS</span>'
        : (logo
          ? '<img src="' + esc(logo) + '" alt="' + esc(b.legalName) + '" style="max-height:48px;max-width:240px;display:inline-block;">'
          : esc(b.legalName)),
      accent,
    };
  }

  function generateDealPageHTML(deal) {
    // Every tier the rep PRICED, cheapest first (five since 2026-10-02). An
    // unpriced tier never shows — it would be a $0 package the homeowner
    // could pick (deal-acceptance.js now refuses that too). A three-tier deal
    // saved before 2026-10-02 renders exactly as before.
    const _dt = deal.tiers || {};
    const pricedTiers = dealTiers().filter(t => _dt[t] && Number(_dt[t].price) > 0);
    const _payFor = {};
    pricedTiers.forEach(t => { _payFor[t] = calcMonthlyPayment(_dt[t].price, 7.99, 60); });
    const _recommended = pricedTiers.indexOf('better') !== -1 ? 'better' : null;
    const _stars = { economy: '○', good: '☆', better: '★★', best: '★★★', beyond: '★★★★' };
    const BRAND = _dealBrand();
    // Deposit per tier (2026-09-25) — deposit-rule.js, the same answer the
    // quote, contract and invoice give: cash under $2,000 none, $2,000+ 50%
    // at signing, insurance the deductible + the ACV payment. The deal page
    // named no deposit at all, and its insurance box said "you typically only
    // pay your deductible" — true of the homeowner's pocket, but silent on
    // the ACV payment the rule asks for up front.
    const _depRule = window.NBDDepositRule || null;
    const _dealMode = deal.insuranceClaim ? 'insurance' : 'cash';
    // The lead for the Kentucky hold (2026-10-03): the deal's own claim fields
    // over the linked lead's. A claim NUMBER with no carrier left _dealMode
    // 'cash' while the KY notices below (classify on claimNumber) printed —
    // so the page asked a 50% deposit on a KY insurance job (KRS 367.626).
    let _linked = null;
    try {
      _linked = deal.leadId
        ? ((window._leadDoc && window._leadDoc.id === deal.leadId) ? window._leadDoc
          : ((Array.isArray(window._leads) && window._leads.find(l => l && l.id === deal.leadId)) || null))
        : null;
    } catch (_) { _linked = null; }
    const _depLead = Object.assign({}, _linked || {}, {
      address: deal.address || (_linked && _linked.address) || '',
      claimNumber: deal.claimNumber || (_linked && _linked.claimNumber) || '',
      insCarrier: deal.insuranceCarrier || (_linked && (_linked.insCarrier || _linked.insuranceCarrier)) || ''
    });
    const _tierPlan = (price) => (_depRule && Number(price) > 0)
      ? _depRule.compute({ total: Number(price), mode: _dealMode, deductible: deal.deductible, address: deal.address || '', lead: _depLead })
      : null;
    const depositLine = (price) => {
      const p = _tierPlan(price);
      return p ? `<div class="tier-deposit">${esc(p.label)}: <strong>${esc(p.valueText)}</strong></div>` : '';
    };
    const _insPlan = ['better', 'good', 'best', 'economy', 'beyond'].map(t => _dt[t] && _tierPlan(_dt[t].price)).find(Boolean) || null;

    // Kentucky SB 153 (2026-09-27). The homeowner signs and ACCEPTS here, so
    // for a Kentucky insurance deal (or an insurance deal whose state cannot
    // be read — fail closed) this page is a contract entry: it carries the two
    // KRS 367.624(3) notices before the signature pad and the detachable
    // NOTICE OF CANCELLATION in duplicate after it, completed with the
    // contractor's address from the Company Profile. No address → the page is
    // refused (the caller toasts the reason) rather than printed with a blank.
    const _KY = window.NBDJurisdiction || null;
    const _kyJ = _KY ? _KY.classify({
      address: deal.address, insuranceClaim: deal.insuranceClaim === true,
      insuranceCarrier: deal.insuranceCarrier, claimNumber: deal.claimNumber
    }) : null;
    let kyCss = '', kyNotices = '', kyForms = '';
    if (_kyJ && _kyJ.kyInsurance) {
      const _cp = (window._legal ? window._legal() : window._companyProfile) || {};
      // brand.contact.mailingAddress only (Jo, 2026-09-27) — never the letterhead address.
      let _brandSrc = null;
      try { _brandSrc = window._brand ? window._brand() : null; } catch (_) { _brandSrc = null; }
      const _addr = _KY.contractorMailingAddress(_brandSrc) || _KY.contractorMailingAddress(_cp);
      if (!_addr) {
        const err = new Error(_KY.MSG.addressRequired);
        err.code = 'ky-address-required';
        throw err;
      }
      let _email = deal.repEmail || '';
      try { const _b = window._brand ? window._brand() : null; _email = (_b && _b.contact && _b.contact.email) || _email; } catch (_) {}
      kyCss = _KY.STATUTORY_CSS;
      kyNotices = '<div style="background:#fff;color:#111;border-radius:10px;padding:14px;margin:16px 0;">' +
        '<div style="font-size:12px;margin-bottom:8px;color:#333;">' + esc(BRAND.name) + ' · Mailing address: ' + esc(_addr) + '</div>' +
        _KY.kyNoticesHtml() + '</div>';
      kyForms = '<div style="background:#fff;color:#111;border-radius:10px;padding:14px;margin-top:20px;">' +
        _KY.kyCancellationFormsHtml({ transactionDate: new Date(), timeZone: _KY.resolveTimeZone(_cp), physicalAddress: _addr, email: _email, fax: _cp.businessFax || '' }) +
        '</div>';
    }

    return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Your Roof Estimate — ${BRAND.nameEsc}</title>
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;600;700;800&family=Barlow:wght@400;500;600;700&display=swap" rel="stylesheet">
${kyCss}
<style>
/* Standalone generated page: define the token locally so the color-mix
   glow below resolves (visual audit 2026-07-19 — var(--orange) was
   undefined here, the declaration was invalid, glow never rendered). */
:root{--orange:${BRAND.accent};}
*{margin:0;padding:0;box-sizing:border-box;}
body{font-family:'Barlow',sans-serif;background:#0d0f14;color:#e5e7eb;min-height:100vh;}
.hero{background:linear-gradient(135deg,#1a1d23 0%,#0d0f14 100%);padding:40px 20px 30px;text-align:center;border-bottom:2px solid var(--orange);}
.logo{font-family:'Barlow Condensed',sans-serif;font-size:28px;font-weight:800;letter-spacing:.04em;}
.logo span{color:var(--orange);}
.addr{font-size:14px;color:#8b8e96;margin-top:8px;}
.customer{font-size:18px;font-weight:600;margin-top:12px;}
.rep-bar{display:flex;align-items:center;justify-content:center;gap:12px;margin-top:16px;padding:12px 20px;background:#1e2028;border-radius:10px;max-width:400px;margin-left:auto;margin-right:auto;}
.rep-name{font-size:13px;font-weight:600;}
.rep-contact{font-size:11px;color:#8b8e96;}
.container{max-width:600px;margin:0 auto;padding:20px;}
.section-title{font-family:'Barlow Condensed',sans-serif;font-size:15px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--orange);margin:24px 0 12px;}
.tier-cards{display:flex;flex-direction:column;gap:12px;}
.tier{background:#1e2028;border:2px solid #2a2d35;border-radius:14px;padding:20px;cursor:pointer;transition:all .2s;position:relative;overflow:hidden;}
.tier:hover{border-color:color-mix(in srgb, var(--orange) 25%, transparent);}
.tier.selected{border-color:var(--orange);box-shadow:0 0 20px color-mix(in srgb, var(--orange) 20%, transparent);}
.tier.recommended::before{content:'RECOMMENDED';position:absolute;top:10px;right:-28px;background:var(--orange);color:white;font-size:9px;font-weight:700;padding:2px 30px;transform:rotate(45deg);letter-spacing:.08em;}
.tier-name{font-family:'Barlow Condensed',sans-serif;font-size:20px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;}
.tier-price{font-size:28px;font-weight:700;color:var(--orange);margin:8px 0;}
.tier-monthly{font-size:12px;color:#8b8e96;}
.tier-desc{font-size:13px;color:#8b8e96;margin-top:8px;line-height:1.5;}
.tier-warranty{font-size:11px;color:var(--orange);margin-top:6px;font-weight:600;}
.tier-deposit{font-size:12px;color:#e5e7eb;margin-top:6px;}
.tier-items{margin-top:12px;border-top:1px solid #2a2d35;padding-top:10px;}
.tier-item{display:flex;justify-content:space-between;padding:4px 0;font-size:12px;color:#8b8e96;border-bottom:1px solid #1a1d2310;}
.finance-section{margin-top:20px;}
.finance-opt{display:flex;align-items:center;gap:10px;padding:12px;background:#1e2028;border:2px solid #2a2d35;border-radius:10px;margin-bottom:8px;cursor:pointer;transition:all .2s;}
.finance-opt:hover{border-color:var(--orange)40;}
.finance-opt.selected{border-color:var(--orange);background:var(--orange)10;}
.finance-label{font-size:13px;font-weight:600;flex:1;}
.finance-payment{font-size:14px;font-weight:700;color:var(--orange);}
.insurance-box{background:#1e2028;border:1px solid #2a2d35;border-radius:10px;padding:16px;margin-top:16px;}
.ins-label{font-size:11px;font-weight:700;color:var(--orange);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px;}
.ins-detail{font-size:13px;color:#e5e7eb;}
.sign-section{margin-top:24px;text-align:center;}
.sign-canvas-wrap{background:#fff;border-radius:10px;margin:12px auto;max-width:400px;height:120px;position:relative;}
.sign-canvas{width:100%;height:100%;border-radius:10px;cursor:crosshair;}
.sign-clear{position:absolute;top:4px;right:8px;background:none;border:none;color:#999;font-size:11px;cursor:pointer;}
.sign-btn{padding:16px 40px;background:var(--orange);color:white;border:none;border-radius:12px;font-size:16px;font-weight:700;font-family:'Barlow Condensed',sans-serif;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;margin-top:12px;transition:all .2s;}
.sign-btn:hover{filter:brightness(1.15);}
.sign-btn:disabled{opacity:.4;cursor:not-allowed;}
.schedule-section{margin-top:20px;text-align:center;}
.schedule-input{padding:12px;background:#1e2028;border:1px solid #2a2d35;border-radius:8px;color:#e5e7eb;font-size:14px;font-family:'Barlow',sans-serif;width:100%;max-width:300px;}
.footer{text-align:center;padding:30px 20px;font-size:11px;color:#8b8e96;border-top:1px solid #2a2d35;margin-top:30px;}
.success-overlay{display:none;position:fixed;top:0;right:0;bottom:0;left:0;background:rgba(10,11,14,.97);z-index:100;align-items:center;justify-content:center;flex-direction:column;gap:16px;padding:24px;}
.success-overlay.show{display:flex;}
.success-icon{font-size:60px;}
.success-text{font-size:22px;font-weight:700;font-family:'Barlow Condensed',sans-serif;}
.success-sub{font-size:14px;line-height:1.5;color:#c9ccd2;max-width:320px;text-align:center;}
.warranty-badge{display:inline-block;background:linear-gradient(135deg,var(--orange),#ff8c42);color:white;padding:8px 20px;border-radius:20px;font-size:12px;font-weight:700;font-family:'Barlow Condensed',sans-serif;letter-spacing:.04em;margin-top:12px;}
@media(max-width:500px){.tier-price{font-size:22px;}.tier-name{font-size:17px;}}
</style>
</head><body>

<div class="hero">
  <div class="logo">${BRAND.logoHtml}</div>
  <div class="customer">${esc(deal.customerName) || 'Homeowner'}</div>
  <div class="addr">${esc(deal.address)}</div>
  <div class="rep-bar">
    <div>
      <div class="rep-name">${esc(deal.repName)}</div>
      <div class="rep-contact">${esc(deal.repPhone)} · ${esc(deal.repEmail)}</div>
    </div>
  </div>
  <div class="warranty-badge">${esc(deal.warranty)}</div>
</div>

<div class="container">
  <div class="section-title">Choose Your Roof Package</div>
  <div class="tier-cards">
    ${pricedTiers.map(t => `
    <div class="tier${t === _recommended ? ' recommended' : ''}" id="tier-${t}" data-deal-tier="${t}">
      <div class="tier-name">${_stars[t] || ''} ${esc(tierDisplayLabel(t))}</div>
      <div class="tier-price">${fmtCurrency(_dt[t].price)}</div>
      <div class="tier-monthly">or ~${fmtCurrency(_payFor[t])}/mo with financing</div>
      <div class="tier-desc">${esc(_dt[t].description || TIER_DESCRIPTIONS[t] || '')}</div>
      <div class="tier-warranty">🛡️ ${esc(tierDisplayWarrantyBlurb(t))}</div>
      ${depositLine(_dt[t].price)}
    </div>`).join('')}
  </div>

  ${deal.insuranceClaim ? `
  <div class="insurance-box">
    <div class="ins-label">📋 Insurance Claim Info</div>
    <div class="ins-detail">Carrier: <strong>${esc(deal.insuranceCarrier)}</strong></div>
    ${deal.claimNumber ? `<div class="ins-detail">Claim #: ${esc(deal.claimNumber)}</div>` : ''}
    ${deal.deductible ? `<div class="ins-detail">Your deductible: <strong>${fmtCurrency(deal.deductible)}</strong></div>` : ''}
    <div style="font-size:11px;color:#8b8e96;margin-top:8px;">You manage your claim with your insurer; we provide our estimate and documentation. ${esc(_insPlan && _insPlan.terms ? _insPlan.terms : '')}</div>
  </div>
  ` : ''}

  <div class="section-title">Financing Options</div>
  <div class="finance-section" id="financeOpts"></div>

  <div class="section-title">Sign & Schedule</div>
  ${kyNotices}
  <div class="sign-section">
    <p style="font-size:13px;color:#8b8e96;margin-bottom:8px;">By signing below, you authorize ${BRAND.nameEsc} to proceed with the selected roof package.</p>
    <div class="sign-canvas-wrap">
      <canvas id="sigCanvas" class="sign-canvas"></canvas>
      <button class="sign-clear" data-deal-action="clearSig">Clear</button>
    </div>
    <div class="schedule-section">
      <p style="font-size:12px;color:#8b8e96;margin-bottom:8px;">Preferred installation date:</p>
      <input type="date" id="schedDate" class="schedule-input" min="${new Date().toISOString().split('T')[0]}">
    </div>
    <button class="sign-btn" id="submitBtn" data-deal-action="submit" disabled>✓ ACCEPT & SCHEDULE</button>
  </div>
  ${kyForms}

  <div class="footer">
    <div>${BRAND.nameEsc} · Licensed & Insured</div>
    <div style="margin-top:4px;">This estimate is valid until ${fmtDate(deal.expiresAt)}</div>
  </div>
</div>

<div class="success-overlay" id="successOverlay">
  <div class="success-icon">🎉</div>
  <div class="success-text">You're All Set!</div>
  <div class="success-sub">We've received your selection and signature. Your rep ${esc(deal.repName)} will be in touch shortly to confirm your installation date.</div>
</div>

<script type="application/json" id="nbd-deal-data">${
    // Data island, not executable script — CSP does not block JSON blocks.
    // Escape < so lead-sourced strings can never close the tag early.
    JSON.stringify({
      prices: Object.fromEntries(pricedTiers.map(t => [t, _dt[t].price])),
      rates: FINANCING_RATES,
    }).replace(/</g, '\\u003c')
  }</script>
<script src="https://nobigdealwithjoedeal.com/pro/deal-room.js?v=2"><\/script>
</body></html>`;
  }

  // ============================================================================
  // SHARE FUNCTIONS
  // ============================================================================

  // generateDealPageHTML throws for a Kentucky insurance deal with no business
  // address on the Company Profile (2026-09-27). Callers use this: the rep
  // gets the reason, and nothing half-complete is shared.
  function _dealHtmlOrToast(deal) {
    try { return generateDealPageHTML(deal); }
    catch (e) {
      if (e && e.code === 'ky-address-required') {
        if (window.showToast) window.showToast(e.message, 'error');
        return null;
      }
      throw e;
    }
  }

  function generateShareableLink(deal) {
    // Generate the HTML and store as a data URL or blob URL
    const html = _dealHtmlOrToast(deal);
    if (html == null) return null;
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);

    // Also try Firebase Storage if available
    if (window._storage) {
      uploadDealPage(deal, html);
    }

    return url;
  }

  async function uploadDealPage(deal, html) {
    if (!window._storage || !window._user) return null;
    try {
      const { ref, uploadString, getDownloadURL } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js');
      const storageRef = ref(window._storage, `deal_rooms/${window._user.uid}/${deal.id}.html`);
      await uploadString(storageRef, html, 'raw', { contentType: 'text/html' });
      const downloadUrl = await getDownloadURL(storageRef);
      deal.shareUrl = downloadUrl;
      saveDealRooms();
      syncDealToFirestore(deal);
      return downloadUrl;
    } catch (e) {
      console.error('Deal page upload error:', e);
      return null;
    }
  }

  // async since 2026-09-06: the filename carries a tenant-resolved prefix and
  // company-profile hydration must be awaited (company-profile.js
  // _tenantFilePrefix). Only reachable via the deal-room buttons and the
  // CloseBoard.preview export, whose sole consumers (estimate-v2-ui,
  // rep-os) use createFromEstimate/getDeals — nothing awaits this.
  async function openDealPreview(dealId) {
    const deal = _findDeal(dealId);
    if (!deal) return;
    const html = _dealHtmlOrToast(deal);
    if (html == null) return;
    // CB fix: the deal preview is INTERACTIVE (pick tier, choose financing,
    // sign, ACCEPT). Its inline <script> + onclick handlers are dead inside the
    // NBDDocViewer srcdoc sandbox (no allow-same-origin + the dashboard's strict
    // CSP), which left every preview control inert. Open it as a blob-URL tab
    // instead — a top-level document with no inherited CSP, so it behaves exactly
    // like the customer's shared link. The doc viewer stays as a visual-only
    // fallback if the popup is blocked.
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const w = window.open(url, '_blank');
    if (w) {
      // Free the blob once the new tab has had time to load the document.
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 60000);
      return;
    }
    // Popup blocked — fall back to the (script-sandboxed) doc viewer so the rep
    // can at least see the layout. Release the blob URL we won't use.
    try { URL.revokeObjectURL(url); } catch (_) {}
    if (window.NBDDocViewer && typeof window.NBDDocViewer.open === 'function') {
      const slug = String(deal.customerName || dealId || 'deal').replace(/[^A-Za-z0-9]+/g, '-').substring(0, 40);
      // Tenant-resolved prefix — '' when the brand is not hydrated, never 'NBD'.
      const _dealBase = 'Deal-' + slug + '-' + new Date().toISOString().split('T')[0] + '.pdf';
      const _dealName = window._tenantFileName ? await window._tenantFileName(_dealBase) : _dealBase;
      window.NBDDocViewer.open({
        html: html,
        title: 'Deal Preview — ' + (deal.customerName || 'Deal #' + dealId),
        filename: _dealName
      });
    }
  }

  // A deal text queued offline (sms-outbox.js) is stamped SENT when the outbox
  // actually sends it, and only if the deal has not moved on in the meantime.
  // The send can happen in another tab or on a page load before this file is
  // loaded (it comes with its view, via ScriptLoader), so the outbox keeps a
  // receipt and hands it over here through onSent() whenever this loads.
  const DEAL_SMS_SOURCE = 'deal-sms';
  function _applyDealSmsReceipt(d) {
    if (!d || typeof d.sourceRef !== 'string' || !d.sourceRef) return false;
    // Drained before init() ran: the board's deals are still in localStorage.
    if (!dealRooms.length) loadDealRooms();
    const deal = dealRooms.find(x => x.id === d.sourceRef);
    if (!deal || (deal.status && deal.status !== DEAL_STATUS.DRAFT)) return false;
    updateDeal(deal.id, { status: DEAL_STATUS.SENT, sentAt: new Date().toISOString(), sentVia: 'sms' });
    if (currentTab !== 'create') render();
    return true;
  }
  function _registerDealSmsReceipts() {
    const ob = window.NBDSmsOutbox;
    if (!ob || typeof ob.onSent !== 'function') return false;
    ob.onSent(DEAL_SMS_SOURCE, _applyDealSmsReceipt);
    return true;
  }
  if (!_registerDealSmsReceipts() && typeof window.addEventListener === 'function') {
    window.addEventListener('nbd:sms-outbox-ready', _registerDealSmsReceipts, { once: true });
  }

  // integrations/sms.a2pApproved as last reported by createDealAcceptToken.
  // false until the server says otherwise — a missing answer means phone.
  let _serverSmsOk = false;
  // Jo-tapped shares awaiting a fresh tap (Safari drops the share sheet's
  // user activation while the link is minted): dealId → message.
  const _phonePending = Object.create(null);

  // Send the deal link from Jo's own phone. SENT is stamped ONLY when the
  // share sheet resolved or Jo confirmed the Messages hand-off went out, and
  // only escalated from draft (a viewed deal never regresses), with
  // sentVia 'phone' → "shared from your phone".
  async function _shareDealFromPhone(dealId, deal, msg, shareUrl) {
    if (!window.NBDPhoneShare) {
      if (window.showToast) window.showToast('Sharing is still loading — try again', 'error');
      return;
    }
    const res = await window.NBDPhoneShare.share({
      text: msg, phone: deal.customerPhone, title: 'Roof estimate',
      noRetry: !!_phonePending[dealId],
    });
    if (res.needsTap) {
      _phonePending[dealId] = msg;
      if (window.showToast) window.showToast('Link ready — tap 📱 Text again to send it from your phone', 'info');
      return;
    }
    delete _phonePending[dealId];
    if (!res.shared) return;
    const cur = _findDeal(dealId) || deal;
    updateDeal(dealId, Object.assign(
      { sentAt: new Date().toISOString(), sentVia: 'phone' },
      (!cur.status || cur.status === DEAL_STATUS.DRAFT) ? { status: DEAL_STATUS.SENT } : {}
    ));
    if (window.showToast) window.showToast('Shared from your phone ✓', 'success');
  }

  async function sendViaSMS(dealId) {
    const deal = _findDeal(dealId);
    if (!deal || !deal.customerPhone) {
      if (window.showToast) window.showToast('No phone number for this customer', 'error');
      return;
    }
    // Second tap after Safari refused the first share: the link is already
    // minted and the message written — share it now, inside this tap.
    if (_phonePending[dealId]) {
      return _shareDealFromPhone(dealId, deal, _phonePending[dealId], '');
    }

    // Upload + mint a single-use accept link (/deal/<token>) the homeowner
    // can actually accept from — not the raw Storage URL.
    const shareUrl = await getDealAcceptLink(deal);

    if (shareUrl) {
      // Certification finding: outbound SMS/email named NBD while the linked
      // page was tenant-branded (dead fallback chain on dashboard). Use the
      // same resolver as the generated page.
      const brand = _dealBrand().name;
      const msg = `Hi ${deal.customerName || 'there'}! Here's your roof estimate from ${brand}. View your options, compare packages, and sign digitally: ${shareUrl}`;
      // 2026-10-03: while the server's Twilio number is not A2P-registered
      // (integrations/sms.a2pApproved, default false) a server text is
      // "accepted" and never delivered — 0 of 23 in 45 days, all stamped
      // SENT. So the link goes from Jo's own phone (share sheet, or Messages
      // with the text written), and the deal is marked sent ONLY when he
      // actually sent it — labelled "shared from your phone".
      if (!_serverSmsOk || !(window.NBDComms && typeof window.NBDComms.sendSMS === 'function')) {
        return _shareDealFromPhone(dealId, deal, msg, shareUrl);
      }
      // A2P approved: the server number delivers, so the platform send is back.
      const result = await window.NBDComms.sendSMS({
        to: deal.customerPhone,
        message: msg,
        leadId: deal.leadId || null,
        source: DEAL_SMS_SOURCE,
        sourceRef: dealId,
      });
      // Offline: stored in the outbox, NOT sent. No SENT stamp (it feeds
      // close-rate analytics) until the outbox actually sends it — see
      // _applyDealSmsReceipt above. NBDComms already toasted.
      if (result && result.success && result.mode === 'queued') {
        return;
      }
      if (result && result.success) {
        updateDeal(dealId, { status: DEAL_STATUS.SENT, sentAt: new Date().toISOString(), sentVia: 'sms' });
        return;
      }
    } else {
      // Fallback: copy link
      if (window.showToast) window.showToast('Upload failed — preview the deal and share manually', 'warning');
    }
  }

  async function sendViaEmail(dealId) {
    const deal = _findDeal(dealId);
    if (!deal || !deal.customerEmail) {
      if (window.showToast) window.showToast('No email for this customer', 'error');
      return;
    }

    const shareUrl = await getDealAcceptLink(deal);

    // Fail CLOSED without a link, exactly like sendViaSMS and copyDealLink.
    // This used to send anyway with "View your options here: [Link will be
    // available shortly]" and then stamp the deal SENT (synced to Firestore,
    // counted in close-rate analytics): the homeowner got an estimate email
    // with no way to view or sign it. getDealAcceptLink has already toasted
    // why it failed; nothing is sent and the deal stays as it was.
    if (!shareUrl) {
      if (window.showToast) window.showToast('Could not create the accept link — preview the deal and share manually', 'warning');
      return;
    }

    // Certification finding: outbound SMS/email named NBD while the linked

    // page was tenant-branded (dead fallback chain on dashboard). Use the

    // same resolver as the generated page.

    const brand = _dealBrand().name;
    const subject = `Your Roof Estimate — ${brand}`;
    const body = `Hi ${deal.customerName || 'there'},\n\nThank you for giving us the opportunity to earn your business! I've put together your personalized roof estimate.\n\nView your options here: ${shareUrl}\n\nYou can compare packages, see financing options, and digitally sign — all from your phone.\n\nBest,\n${deal.repName || ''}\n${brand}\n${deal.repPhone || ''}`;

    if (window.NBDComms && typeof window.NBDComms.sendEmail === 'function') {
      const result = await window.NBDComms.sendEmail({
        to: deal.customerEmail,
        subject: subject,
        body: body,
        leadId: deal.leadId || null,
        kind: 'proposal', // transactional: the estimate/accept link for this deal
      });
      if (result && result.success) {
        updateDeal(dealId, { status: DEAL_STATUS.SENT, sentAt: new Date().toISOString(), sentVia: 'email' });
        return;
      }
    } else {
      window.open(`mailto:${deal.customerEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`, '_self');
      updateDeal(dealId, { status: DEAL_STATUS.SENT, sentAt: new Date().toISOString(), sentVia: 'email' });
    }
  }

  // Build the first-party ACCEPT link for a deal: upload the interactive HTML
  // to Storage, then mint a single-use token via createDealAcceptToken. The
  // homeowner opens /deal/<token> (served same-origin by getDealRoom) and can
  // actually ACCEPT — submitDealAcceptance records tier + signature + date and
  // notifies the rep. Returns the /deal/<token> URL, or null on failure.
  async function getDealAcceptLink(deal) {
    if (!window._user) {
      if (window.showToast) window.showToast('Sign in required to create a share link', 'error');
      return null;
    }
    try { await syncDealToFirestore(deal); } catch (_) {}
    const html = _dealHtmlOrToast(deal);
    if (html == null) return null;
    await uploadDealPage(deal, html); // → deal_rooms/<uid>/<dealId>.html
    // Load the Functions SDK ourselves when no other feature has yet. This
    // used to bail with "Sign in required" whenever window._functions /
    // _httpsCallable were unset — and nothing sets them at dashboard boot
    // (only lazily, from unrelated features), so in a fresh session Text,
    // Email and Copy all failed for a signed-in rep. Same lazy pattern as
    // session-revoke.js getCallable(), INCLUDING the emulator connect: a local
    // emulator run that skipped it would mint tokens against PRODUCTION.
    if (!window._httpsCallable || !window._functions) {
      try {
        const mod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js');
        window._functions = window._functions || mod.getFunctions();
        try {
          const emu = await import('./nbd-emulator-connect.js');
          await emu.connectEmulatorsIfLocal({ functions: window._functions }); // no-op in prod
        } catch (_) { /* prod path: module absent or already connected */ }
        window._httpsCallable = window._httpsCallable || mod.httpsCallable;
      } catch (e) {
        console.error('Functions SDK load failed:', e);
        if (window.showToast) window.showToast('Could not load the link service — try again', 'error');
        return null;
      }
    }
    try {
      const fn = window._httpsCallable(window._functions, 'createDealAcceptToken');
      const res = await fn({ dealId: deal.id });
      const acceptUrl = res && res.data && res.data.acceptUrl;
      // integrations/sms.a2pApproved, read server-side (default false).
      _serverSmsOk = !!(res && res.data && res.data.a2pApproved === true);
      if (acceptUrl) { deal.acceptUrl = acceptUrl; saveDealRooms(); }
      return acceptUrl || null;
    } catch (e) {
      console.error('createDealAcceptToken failed:', e);
      // An accepted deal gets no new link (deal-acceptance.js DONE_STATUSES) —
      // say so, rather than "try again", which never succeeds.
      const done = e && /failed-precondition/.test(String(e.code || ''));
      if (window.showToast) window.showToast(done ? (e.message || 'This deal is already accepted.') : 'Could not create the accept link — try again', done ? 'info' : 'error');
      return null;
    }
  }

  async function copyDealLink(dealId) {
    const deal = _findDeal(dealId);
    if (!deal) return;
    if (window.showToast) window.showToast('Creating accept link…', 'info');
    const url = await getDealAcceptLink(deal);
    if (!url) return; // getDealAcceptLink already surfaced the failure
    // Mark the first share as Sent so Analytics counts a copied link like
    // SMS/email do (sentAt is the close-rate denominator). Escalate status only
    // from draft so a viewed/accepted deal is never regressed to 'sent'.
    if (!deal.sentAt) {
      updateDeal(dealId, Object.assign(
        { sentAt: new Date().toISOString(), sentVia: 'link' },
        deal.status === DEAL_STATUS.DRAFT ? { status: DEAL_STATUS.SENT } : {}
      ));
    }
    try {
      await navigator.clipboard?.writeText(url);
      if (window.showToast) window.showToast('Accept link copied!', 'success');
    } catch (e) {
      if (window.showToast) window.showToast('Link ready — paste it to your customer', 'success');
    }
  }

  // ============================================================================
  // UI RENDERING
  // ============================================================================

  function setTab(tab) {
    currentTab = tab;
    render();
  }

  function render() {
    const container = document.getElementById('view-closeboard');
    if (!container) return;
    const scroll = container.querySelector('.view-scroll') || container;
    _dealRoomsForCurrentUser();

    // Lapse past-expiry, non-closed deals to 'expired' so the Active list/count
    // stop carrying them forever — nothing else transitions them (no server
    // cron). Display-only and idempotent on every paint.
    const _now = Date.now();
    dealRooms.forEach(d => {
      if (d && d.expiresAt && new Date(d.expiresAt).getTime() < _now &&
          ![DEAL_STATUS.ACCEPTED, DEAL_STATUS.SIGNED, DEAL_STATUS.SCHEDULED, DEAL_STATUS.EXPIRED].includes(d.status)) {
        d.status = DEAL_STATUS.EXPIRED;
      }
    });

    const tabBtn = (id, label, icon) => {
      const active = currentTab === id;
      return `<button data-cb-action="setTab" data-cb-id="${id}" style="padding:8px 16px;border:none;border-radius:8px;background:${active ? 'var(--orange,#BD5728)' : 'var(--s2,#1e2028)'};color:${active ? '#fff' : 'var(--m,#8b8e96)'};font-size:12px;font-weight:${active ? '700' : '500'};font-family:'Barlow Condensed',sans-serif;cursor:pointer;letter-spacing:.03em;transition:all .15s;">${icon} ${label}</button>`;
    };

    // The Active tab LISTS every non-expired deal (closed ones stay visible),
    // but the Active Deals stat counts only OPEN ones — an accepted deal is in
    // Signed / Closed Value, and Rep OS already counted it that way.
    const active = dealRooms.filter(d => d.status !== DEAL_STATUS.EXPIRED);
    const openCount = active.filter(d => !_isClosedDeal(d)).length;
    // A remote homeowner acceptance lands as status 'accepted' (deal-acceptance.js);
    // count it as closed alongside signed/scheduled so Closed Value actually moves.
    const signed = dealRooms.filter(d => d.status === DEAL_STATUS.ACCEPTED || d.status === DEAL_STATUS.SIGNED || d.status === DEAL_STATUS.SCHEDULED);
    const totalValue = signed.reduce((s, d) => s + dealValue(d), 0);

    let html = `
      <div class="cbr-pad-top">
        <div class="cbr-head">
          <div>
            <div class="cbr-title">📋 CLOSE BOARD</div>
            <div class="cbr-m12-mt2">Shareable deal rooms — one link to close</div>
          </div>
          <button data-cb-action="createNew" class="cbr-btn-new">
            + NEW DEAL
          </button>
        </div>

        <!-- Stats -->
        <div class="cb-stats-row cbr-scroll-row">
          <div class="ui-stat">
            <div class="cbr-v22-blue">${openCount}</div>
            <div class="cbr-label">Active Deals</div>
          </div>
          <div class="ui-stat">
            <div class="cbr-v22-orange">${dealRooms.filter(wasViewed).length}</div>
            <div class="cbr-label">Viewed</div>
          </div>
          <div class="ui-stat">
            <div class="cbr-v22-green">${signed.length}</div>
            <div class="cbr-label">Signed</div>
          </div>
          <div class="ui-stat">
            <div class="cbr-v22-green">${fmtCurrency(totalValue)}</div>
            <div class="cbr-label">Closed Value</div>
          </div>
        </div>

        <!-- Tabs -->
        <div class="cbr-row6-mb">
          ${tabBtn('active', 'Active Deals', '📋')}
          ${tabBtn('create', 'New Deal', '➕')}
          ${tabBtn('analytics', 'Analytics', '📊')}
        </div>
      </div>

      <div class="cbr-pad-body">
    `;

    if (currentTab === 'active') {
      html += renderActiveDeals();
    } else if (currentTab === 'create') {
      html += renderCreateForm();
    } else if (currentTab === 'analytics') {
      html += renderAnalytics();
    }

    html += '</div>';
    scroll.innerHTML = html;

    // NEW-C2: bind the New-Deal insurance toggle on every paint. render()
    // replaces innerHTML, so #cb-insurance is a fresh node each time — binding
    // here attaches exactly one listener (no accumulation) and survives tab
    // round-trips, unlike the one-shot setTimeout bind in init() which fired
    // before the create form existed on the default 'active' tab.
    const insToggle = scroll.querySelector('#cb-insurance');
    if (insToggle) {
      insToggle.addEventListener('change', () => {
        const fields = scroll.querySelector('#cb-ins-fields');
        if (fields) fields.style.display = insToggle.checked ? 'block' : 'none';
      });
    }

    // Delegated click handler — replaces previously-inline onclick handlers
    // that were silently no-op'd by prod CSP `script-src-attr 'none'`. The
    // CSP blocks inline event-handler attributes even when injected via
    // innerHTML, so the buttons rendered above need a property-based
    // handler attached to the container.
    scroll.onclick = function (ev) {
      const target = ev.target.closest('[data-cb-action]');
      if (!target) return;
      const action = target.dataset.cbAction;
      const id = target.dataset.cbId;
      const fn = window.CloseBoard && window.CloseBoard[action];
      if (typeof fn === 'function') {
        try { id ? fn(id) : fn(); }
        catch (e) { console.error('[close-board] dispatch failed for ' + action + ':', e); }
      } else {
        console.warn('[close-board] unknown action:', action);
      }
    };
  }

  // "shared from your phone" is the honest label for a link Jo sent himself
  // (2026-10-03) — the CRM saw him tap share, not a delivery receipt.
  function sentViaLabel(via) {
    return via === 'phone' ? '📤 shared from your phone' : '📤 via ' + via;
  }

  function renderActiveDeals() {
    if (dealRooms.length === 0) {
      return `
        <div class="cbr-empty">
          <div class="cbr-empty-icon">📋</div>
          <div class="cbr-name">No Deal Rooms Yet</div>
          <div class="cbr-m12-mt4">Create a deal from any estimate to generate a shareable link.</div>
        </div>
      `;
    }

    return dealRooms.map(d => `
      <div class="cbr-card cbr-card-mb">
        <div class="cbr-between-top">
          <div class="cbr-flex1">
            <div class="cbr-h14">${esc(d.customerName) || 'Unnamed'}</div>
            <div class="cbr-m11-mt2">${esc(d.address) || 'No address'}</div>
            <div class="cbr-actions">
              <span style="font-size:10px;padding:2px 8px;border-radius:10px;background:${STATUS_COLORS[d.status] || 'var(--m)'}20;color:${STATUS_COLORS[d.status] || 'var(--m)'};font-weight:600;text-transform:uppercase;">${esc(d.status)}</span>
              <span class="cbr-pill cbr-pill-t">${fmtCurrency(dealValue(d))}</span>
              ${wasViewed(d) ? `<span class="cbr-pill cbr-pill-m" title="${esc(viewTitle(d))}">${esc(viewBadge(d))}</span>` : ''}
              ${d.sentVia ? `<span class="cbr-pill cbr-pill-m">${esc(sentViaLabel(d.sentVia))}</span>` : ''}
            </div>
          </div>
          <div class="cbr-col4">
            <button data-cb-action="preview" data-cb-id="${esc(d.id)}" class="cbr-act cbr-act-blue">👁 Preview</button>
            ${_isClosedDeal(d) ? '' : `<button data-cb-action="sendSMS" data-cb-id="${esc(d.id)}" class="cbr-act cbr-act-green">📱 Text</button>
            <button data-cb-action="sendEmail" data-cb-id="${esc(d.id)}" class="cbr-act cbr-act-orange">📧 Email</button>
            <button data-cb-action="copyLink" data-cb-id="${esc(d.id)}" class="cbr-act cbr-act-plain">🔗 Copy</button>`}
            ${_isClosedDeal(d)
              ? `<span title="A signed deal is kept on record" class="cbr-act cbr-act-static">🔒 On record</span>`
              : `<button data-cb-action="remove" data-cb-id="${esc(d.id)}" class="cbr-act cbr-act-ghost">🗑 Delete</button>`}
          </div>
        </div>
        <div class="cbr-m10-mt8">Created ${timeAgo(d.createdAt)}${_isClosedDeal(d) ? '' : ' · Expires ' + fmtDate(d.expiresAt)}${d.scheduledInstallDate ? ' · 🔨 Install ' + esc(fmtDate(d.scheduledInstallDate)) : ''}</div>
      </div>
    `).join('');
  }

  function renderCreateForm() {
    return `
      <div class="cbr-card cbr-card-16">
        <div class="cbr-h14-mb">Create New Deal Room</div>

        <div class="cbr-mb10">
          <label class="ui-caps-label">Customer Name</label>
          <input class="ui-field-md" id="cb-name" type="text" placeholder="John Smith">
        </div>
        <div class="cbr-row8-mb">
          <div class="cbr-flex1">
            <label class="ui-caps-label">Phone</label>
            <input class="ui-field-md" id="cb-phone" type="tel" placeholder="(555) 123-4567">
          </div>
          <div class="cbr-flex1">
            <label class="ui-caps-label">Email</label>
            <input class="ui-field-md" id="cb-email" type="email" placeholder="john@email.com">
          </div>
        </div>
        <div class="cbr-mb10">
          <label class="ui-caps-label">Address</label>
          <input class="ui-field-md" id="cb-addr" type="text" placeholder="123 Main St, Cincinnati, OH">
        </div>

        <div class="cbr-h12">Pricing Tiers</div>
        <div class="cbr-wrap8">
          ${dealTiers().map(t => `
          <div class="cbr-third">
            <label class="cbr-m10">${({ economy: 'Economy', good: 'Good', better: 'Better', best: 'Best', beyond: 'Beyond' })[t] || t} ($)</label>
            <input class="ui-field-xs" id="cb-${t}" type="number" inputmode="decimal" placeholder="${({ economy: '6500', good: '8000', better: '11000', best: '15000', beyond: '17500' })[t] || ''}">
          </div>`).join('')}
        </div>

        <div class="cbr-mb10">
          <label class="cbr-check-row">
            <input id="cb-insurance" type="checkbox" class="cbr-accent">
            <span class="cbr-t12">Insurance claim</span>
          </label>
        </div>
        <div id="cb-ins-fields" style="display:none;margin-bottom:10px;">
          <div class="cbr-row8">
            <input id="cb-carrier" type="text" placeholder="Insurance carrier" class="cbr-input cbr-input-grow">
            <input id="cb-deductible" type="number" placeholder="Deductible $" class="cbr-input cbr-input-120">
          </div>
        </div>

        <button data-cb-action="submitCreate" class="cbr-btn-create">
          CREATE DEAL ROOM
        </button>
      </div>
    `;
  }

  function renderAnalytics() {
    const total = dealRooms.length;
    const sent = dealRooms.filter(d => d.sentAt).length;
    const viewed = dealRooms.filter(wasViewed).length;
    const signed = dealRooms.filter(d => d.status === DEAL_STATUS.ACCEPTED || d.status === DEAL_STATUS.SIGNED || d.status === DEAL_STATUS.SCHEDULED).length;
    const closeRate = sent > 0 ? Math.round(signed / sent * 100) : 0;

    return `
      <div class="cbr-mt4">
        <div class="cbr-g2">
          <div class="ui-stat-box">
            <div class="cbr-big">${total}</div>
            <div class="cbr-label-tight">Total Deals</div>
          </div>
          <div class="ui-stat-box">
            <div class="cbr-big cbr-c-blue">${sent}</div>
            <div class="cbr-label-tight">Sent</div>
          </div>
          <div class="ui-stat-box">
            <div class="cbr-big cbr-c-amber">${viewed}</div>
            <div class="cbr-label-tight">Viewed</div>
          </div>
          <div class="ui-stat-box">
            <div class="cbr-big cbr-c-green">${closeRate}%</div>
            <div class="cbr-label-tight">Close Rate</div>
          </div>
        </div>

        <div class="cbr-caps11">Conversion Funnel</div>
        <div class="cbr-card">
          ${['Created → Sent', 'Sent → Viewed', 'Viewed → Signed'].map((label, i) => {
            const vals = [
              [total, sent],
              [sent, viewed],
              [viewed, signed]
            ][i];
            const pct = vals[0] > 0 ? Math.round(vals[1] / vals[0] * 100) : 0;
            return `
              <div class="cbr-mb10">
                <div class="cbr-kv">
                  <span>${label}</span>
                  <span class="cbr-b">${pct}% (${vals[1]}/${vals[0]})</span>
                </div>
                <div class="cbr-bar">
                  <div style="height:100%;width:${pct}%;background:var(--orange);border-radius:3px;transition:width .3s;"></div>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  // ============================================================================
  // FORM HANDLERS
  // ============================================================================

  function submitCreateForm() {
    const name = document.getElementById('cb-name')?.value?.trim();
    const phone = document.getElementById('cb-phone')?.value?.trim();
    const email = document.getElementById('cb-email')?.value?.trim();
    const addr = document.getElementById('cb-addr')?.value?.trim();
    const tierPrice = {};
    dealTiers().forEach(t => { tierPrice[t] = parseFloat(document.getElementById('cb-' + t)?.value) || 0; });
    const isInsurance = document.getElementById('cb-insurance')?.checked;
    const carrier = document.getElementById('cb-carrier')?.value?.trim();
    const deductible = parseFloat(document.getElementById('cb-deductible')?.value) || 0;

    if (!name) {
      if (window.showToast) window.showToast('Customer name is required', 'error');
      return;
    }
    if (!dealTiers().some(t => tierPrice[t] > 0)) {
      if (window.showToast) window.showToast('Enter at least one tier price', 'error');
      return;
    }

    const deal = createDealRoom({
      customerName: name,
      customerPhone: phone,
      customerEmail: email,
      address: addr,
      tiers: blankTiers(t => tierPrice[t]),
      insuranceClaim: isInsurance,
      insuranceCarrier: carrier,
      deductible
    });

    if (window.showToast) window.showToast('Deal room created for ' + name, 'success');
    currentTab = 'active';
    render();
  }

  // ============================================================================
  // INIT & PUBLIC API
  // ============================================================================

  let _awaitingUser = false;
  let _awaitTimer = null;
  // Cancel a live waitForUser chain. _awaitingUser alone is not enough: it is
  // only cleared INSIDE the poll, so a re-entrant init() that finds a user and
  // takes the fast path below would leave the 250ms chain running, and its next
  // tick would hydrate a second time — a duplicate Firestore read plus a second
  // repaint. init() is re-entrant in practice: goTo('closeboard') calls it on
  // every navigation to the board.
  function _stopAwaitingUser() {
    _awaitingUser = false;
    if (_awaitTimer !== null) { clearTimeout(_awaitTimer); _awaitTimer = null; }
  }
  function init() {
    loadDealRooms();
    render();
    // Pull server state so remote homeowner acceptances + deals from another
    // device appear and reflect their real status. Async; re-renders on return.
    if (_currentUid()) { _stopAwaitingUser(); hydrateFromFirestore(); return; }
    // dashboard.html#closeboard runs init() from DOMContentLoaded, which can
    // beat the auth callback that publishes window._user. Until it does there
    // is no account key to read, so the board is empty; wait for the user
    // (as D2D does), then load, paint and hydrate.
    if (_awaitingUser) return;
    _awaitingUser = true;
    let tries = 0;
    (function waitForUser() {
      if (_currentUid()) {
        // Via the helper so the (already-fired) timer handle is nulled too,
        // leaving no stale id behind for a later _stopAwaitingUser() to clear.
        _stopAwaitingUser();
        _dealRoomsForCurrentUser();
        // Same guard hydrateFromFirestore() uses: never repaint over a rep
        // who is mid-way through the New Deal form. render() rebuilds the
        // scroll container's innerHTML, and renderCreateForm() emits fresh
        // inputs with no value attribute, so an unconditional repaint here
        // silently blanked every field they had typed — no toast, no warning.
        // This poll is exactly when it happens: init() runs from
        // DOMContentLoaded before auth publishes window._user, so the rep can
        // reach "+ NEW DEAL" and start typing while the 250ms chain is still
        // waiting. hydrateFromFirestore() below re-renders on its own once
        // the data lands, under the same guard.
        if (currentTab !== 'create') render();
        hydrateFromFirestore();
        return;
      }
      if (++tries >= 120) { _stopAwaitingUser(); return; }
      _awaitTimer = setTimeout(waitForUser, 250);
    })();
    // Insurance toggle is bound inside render() (it reattaches on every paint,
    // surviving tab switches); the old one-shot setTimeout bind here fired
    // before the create form existed on the default 'active' tab and is removed.
  }

  function createNew() {
    currentTab = 'create';
    render();
  }

  window.CloseBoard = {
    init,
    render,
    setTab,
    createNew,
    createFromEstimate,
    submitCreate: submitCreateForm,
    preview: openDealPreview,
    sendSMS: sendViaSMS,
    sendEmail: sendViaEmail,
    copyLink: copyDealLink,
    remove: confirmDeleteDeal,
    updateDeal,
    deleteDeal,
    getDeals: () => _dealRoomsForCurrentUser(),
    generatePageHTML: generateDealPageHTML
  };

})();
