/**
 * agent-inbox.js — the Agent inbox: where the Grok Bot team's work lands in
 * the CRM (Jo, 2026-10-02; plan:
 * documentation/projects/GROKBOT-CRM-INTEGRATION-PLAN-2026-10-02.md).
 *
 * Bots never act on a customer. Through the NBD CRM connection they FILE
 * items into agent_inbox/{id} (server-side only); here Jo reviews them:
 *
 *   note      → Approve writes a customer note (top-level `notes`, the same
 *               shape as typing it on the card)
 *   reminder  → Approve writes a dated task on the customer
 *               (leads/{id}/tasks, canonical task shape)
 *   report    → Approve just files it as read
 *
 * Jo (2026-10-02): "I'd rather note it all in the CRM and make notes and
 * reminders there for later over giving me a massive send-out list" — so
 * there is no send action here at all. Text can be edited before approving;
 * "Approve all" clears notes + reminders in one go.
 *
 * Opens from: a 🤖 bell notification (?agentInbox=1), the command palette
 * ("Agent inbox"), or window.NBDAgentInbox.open(). Owner / company_admin
 * only (Firestore rules enforce it; others see nothing).
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  const COLL = 'agent_inbox';
  const KINDS = { note: '📝 Note', reminder: '⏰ Reminder', report: '📄 Report' };
  let _items = [];
  let _busy = false;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const leads = () => (Array.isArray(window._leads) ? window._leads : []);
  const leadName = (id) => {
    const l = leads().find((x) => x && x.id === id);
    return l ? ((((l.firstName || '') + ' ' + (l.lastName || '')).trim()) || l.address || 'Customer') : (id ? 'Customer not on your board' : '');
  };
  const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  const companyKey = () => { const c = window._userClaims || {}; return c.companyId || (window._user && window._user.uid) || null; };
  const canUse = () => {
    const c = window._userClaims || {};
    const uid = window._user && window._user.uid;
    return !!uid && (c.role === 'admin' || c.role === 'company_admin' || !c.companyId || c.companyId === uid);
  };

  /** Group + order pending items (pure): reminders by date, then notes, then reports. */
  function sortItems(items) {
    const rank = { reminder: 0, note: 1, report: 2 };
    return (items || []).slice().sort((a, b) =>
      (rank[a.kind] ?? 3) - (rank[b.kind] ?? 3)
      || String(a.dueDate || '').localeCompare(String(b.dueDate || ''))
      || String(a.bot || '').localeCompare(String(b.bot || '')));
  }

  /** Ids a bulk add takes (pure): notes + reminders, or only the ones Quinn checked. */
  function bulkIds(items, onlyChecked) {
    return sortItems(items).filter((i) => (i.kind === 'note' || i.kind === 'reminder') && (!onlyChecked || i.verified === true)).map((i) => i.id);
  }

  /** The CRM write an approval makes (pure; null for a report). */
  function writeFor(item, uid, email, edited) {
    const text = String(edited != null ? edited : item.text || '').trim().slice(0, 2000);
    if (!text) return { error: 'Empty text' };
    if (item.kind === 'report') return { path: null };
    if (!item.leadId) return { error: 'No customer on this item' };
    if (item.kind === 'note') {
      return { path: ['notes'], data: { leadId: item.leadId, userId: uid, text: text + '\n— filed by ' + (item.bot || 'Agent'), createdBy: email || 'Agent inbox', source: 'agent_inbox', agentItemId: item.id } };
    }
    if (item.kind === 'reminder') {
      if (!isYmd(item.dueDate)) return { error: 'Reminder has no valid date' };
      return { path: ['leads', item.leadId, 'tasks'], data: { leadId: item.leadId, userId: uid, title: text, text, dueDate: item.dueDate, priority: 'normal', notes: 'Filed by ' + (item.bot || 'Agent') + ' (Agent inbox)', done: false, createdBy: email || 'Agent inbox', source: 'agent_inbox', agentItemId: item.id } };
    }
    return { error: 'Unknown item kind' };
  }

  async function load() {
    const key = companyKey();
    if (!key || !window.getDocs || !window.query || !window.where) return [];
    const q = window.query(window.collection(window.db || window._db, COLL), window.where('companyId', '==', key), window.where('status', '==', 'pending'));
    // Opened straight from the 🤖 bell link, this runs while the page is still
    // connecting — and a getDocs then can answer from the EMPTY local cache
    // without saying so (seen in the E2E: "All clear" over 4 waiting items).
    // An empty answer that came from cache is asked again until the server
    // has been heard from.
    let snap = await window.getDocs(q);
    for (let i = 0; i < 6 && snap.empty && snap.metadata && snap.metadata.fromCache; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      snap = await window.getDocs(q);
    }
    return snap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
  }

  function rowHtml(it) {
    const id = esc(it.id);
    const who = it.leadId ? '<span class="ai-cust">' + esc(leadName(it.leadId)) + '</span>' : '';
    const due = it.kind === 'reminder' && it.dueDate ? '<span class="ai-due">due ' + esc(it.dueDate) + '</span>' : '';
    // Quinn either checks an item (verified) or flags it with what is wrong
    // (verified false + quinnNote) — a flag must read as a flag, not "unverified".
    const flagged = !it.verified && it.quinnNote;
    const verified = it.verified ? '<span class="ai-ok">✓ checked by ' + esc(it.verifiedBy || 'Quinn') + '</span>'
      : flagged ? '<span class="ai-flag">⚠ flagged by ' + esc(it.verifiedBy || 'Quinn') + '</span>' : '<span class="ai-unv">unverified</span>';
    return '<div class="ai-item" id="aiItem-' + id + '">' +
      '<div class="ai-top"><span class="ai-kind">' + esc(KINDS[it.kind] || it.kind) + '</span>' + who + due + '</div>' +
      '<div class="ai-meta">from ' + esc(it.bot || 'Agent') + ' · ' + verified + '</div>' +
      (it.quinnNote ? '<div class="ai-qnote">' + esc((it.verified ? 'Quinn: ' : '⚠ Quinn: ') + it.quinnNote) + '</div>' : '') +
      (it.title ? '<div class="ai-title">' + esc(it.title) + '</div>' : '') +
      '<textarea class="ai-text" id="aiText-' + id + '" rows="3" maxlength="2000">' + esc(it.text || '') + '</textarea>' +
      '<div class="ai-actions"><button type="button" class="ai-btn" data-ai-act="dismiss" data-ai-id="' + id + '">Toss</button>' +
      '<button type="button" class="ai-btn is-primary" data-ai-act="approve" data-ai-id="' + id + '">' + (it.kind === 'report' ? 'Got it' : 'Add to CRM') + '</button></div>' +
      '</div>';
  }

  function paint() {
    const list = document.getElementById('aiList');
    if (!list) return;
    const pend = sortItems(_items);
    const notesAndReminders = pend.filter((i) => i.kind === 'note' || i.kind === 'reminder').length;
    const head = document.getElementById('aiCount');
    if (head) head.textContent = pend.length ? pend.length + ' waiting' : 'All clear';
    const bulk = document.getElementById('aiBulk');
    if (bulk) { bulk.hidden = notesAndReminders < 2; bulk.textContent = 'Add all ' + notesAndReminders + ' notes & reminders'; }
    const checked = bulkIds(pend, true).length;
    const bulkOk = document.getElementById('aiBulkChecked');
    // Only worth a second button when it differs from "Add all".
    if (bulkOk) { bulkOk.hidden = checked < 1 || checked === notesAndReminders; bulkOk.textContent = '✓ Add the ' + checked + ' Quinn checked'; }
    const deckBtn = document.getElementById('aiDeck');
    if (deckBtn) { deckBtn.hidden = !(window.NBDTriageDeck && pend.length > 1); deckBtn.textContent = 'One at a time (' + pend.length + ')'; }
    list.innerHTML = pend.length ? pend.map(rowHtml).join('')
      : '<div class="ai-empty">Nothing waiting. When the bots file notes, reminders or reports, they show up here for you to add to the CRM or toss.</div>';
  }

  async function open() {
    if (!canUse()) { if (window.showToast) window.showToast('The Agent inbox is for the owner or an admin', 'error'); return; }
    close();
    const ov = document.createElement('div');
    ov.className = 'ai-overlay'; ov.id = 'aiOverlay';
    ov.innerHTML = '<div class="ai-modal" role="dialog" aria-modal="true" aria-labelledby="aiTitle">' +
      '<div class="ai-head"><div><h2 class="ai-h" id="aiTitle">🤖 Agent inbox</h2><div class="ai-sub" id="aiCount">Loading…</div></div>' +
      '<button type="button" class="ai-close" data-ai-act="close" aria-label="Close">✕</button></div>' +
      '<p class="ai-note">Your bot team files notes, reminders and reports here. Nothing reaches a customer — adding an item only writes it to the customer’s card. Edit before adding.</p>' +
      '<button type="button" class="ai-btn ai-bulk" id="aiDeck" data-ai-act="deck" hidden></button>' +
      '<button type="button" class="ai-btn is-primary ai-bulk" id="aiBulkChecked" data-ai-act="bulkChecked" hidden></button>' +
      '<button type="button" class="ai-btn is-primary ai-bulk" id="aiBulk" data-ai-act="bulk" hidden></button>' +
      '<div id="aiList"></div>' +
      '<details class="ai-conn" id="aiConn"><summary class="ai-conn-sum" data-ai-act="conn">🔌 Connect bots (keys)</summary><div id="aiConnBody"></div></details>' +
      '</div>';
    document.body.appendChild(ov);
    try { _items = await load(); } catch (e) { _items = []; console.warn('[agent-inbox] load failed:', (e && (e.code || e.message)) || e); }
    paint();
  }
  function close() { const o = document.getElementById('aiOverlay'); if (o) o.remove(); }

  // ── Bot keys (functions/agent-mcp.js) ─────────────────────────────────
  // One key per bot, shown ONCE when made. Jo pastes it into that bot's
  // secure box in Grok Bot, with the connection address. Revoke any time.
  async function callable(name, payload) {
    if (!window._httpsCallable) {
      const mod = await import('/assets/vendor/firebase/12.19.0/firebase-functions.js');
      window._httpsCallable = mod.httpsCallable;
    }
    if (!window._functions) throw new Error('Functions SDK unavailable');
    const res = await window._httpsCallable(window._functions, name)(payload || {});
    return res && res.data;
  }

  function connHtml(data, fresh) {
    const keysByBot = {};
    (data.keys || []).filter((k) => k.active).forEach((k) => { (keysByBot[k.botId] = keysByBot[k.botId] || []).push(k); });
    const serverName = fresh && fresh.personal ? 'Jo Tracker' : 'NBD CRM';
    const freshHtml = fresh ? '<div class="ai-key-fresh"><div class="ai-kind">New key for ' + esc(fresh.botName) + ' — copy it now, it is shown once</div>' +
      '<code class="ai-key" id="aiFreshKey">' + esc(fresh.key) + '</code>' +
      '<button type="button" class="ai-btn" data-ai-act="copykey">Copy key</button>' +
      '<div class="ai-meta">In Grok Bot, ask ' + esc(fresh.botName) + ' to add an MCP server named “' + serverName + '” at <b>' + esc(fresh.url) + '</b> through its mcp-remote wrapper with the header <b>Authorization: Bearer &lt;key&gt;</b>, and paste the key into its secure box — never into the chat.' +
      (fresh.personal ? ' This key reads only your own tracker — never the CRM.' : '') + '</div></div>' : '';
    const row = (b) => {
        const ks = keysByBot[b.botId] || [];
        return '<div class="ai-conn-row"><div><div class="ai-kind">' + esc(b.name) + (b.firstWave ? ' <span class="ai-ok">· first wave</span>' : '') + '</div>' +
          '<div class="ai-meta">' + esc(b.tools.join(', ')) + '</div>' +
          ks.map((k) => '<div class="ai-meta">Key ' + esc(k.prefix) + '… · last used ' + esc(k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : 'never') +
            ' <button type="button" class="ai-link" data-ai-act="revoke" data-ai-id="' + esc(k.id) + '">Revoke</button></div>').join('') + '</div>' +
          '<button type="button" class="ai-btn" data-ai-act="mkkey" data-ai-id="' + esc(b.botId) + '">' + (ks.length ? 'New key' : 'Create key') + '</button></div>';
    };
    const bots = data.bots || [];
    const personal = bots.filter((b) => b.personal);
    return freshHtml + '<div class="ai-meta">Address: ' + esc(data.url || '') + '</div>' +
      bots.filter((b) => !b.personal).map(row).join('') +
      (personal.length ? '<div class="ai-kind ai-conn-sec">Personal — reads only your own tracker, never the CRM</div>' + personal.map(row).join('') : '');
  }

  async function paintConn(fresh) {
    const body = document.getElementById('aiConnBody');
    if (!body) return;
    body.innerHTML = '<div class="ai-meta">Loading…</div>';
    try { body.innerHTML = connHtml(await callable('listAgentKeys'), fresh); }
    catch (e) { body.innerHTML = '<div class="ai-meta">Could not load bot keys: ' + esc((e && e.message) || 'error') + '</div>'; }
  }

  async function decide(id, approve) {
    const it = _items.find((x) => x.id === id);
    if (!it || _busy) return false;
    _busy = true;
    try {
      const uid = window._user && window._user.uid;
      const email = window._user && window._user.email;
      const ta = document.getElementById('aiText-' + id);
      const edited = ta ? ta.value : null;
      let result = null;
      if (approve) {
        const w = writeFor(it, uid, email, edited);
        if (w.error) { if (window.showToast) window.showToast(w.error, 'error'); return false; }
        if (w.path) {
          const data = Object.assign({}, w.data, { createdAt: window.serverTimestamp() });
          const ref = await window.addDoc(window.collection.apply(null, [window.db || window._db].concat(w.path)), data);
          result = (w.path[0] === 'notes' ? 'note:' : 'task:') + (ref && ref.id);
        } else result = 'read';
      }
      const patch = { status: approve ? 'approved' : 'dismissed', decidedAt: window.serverTimestamp(), decidedBy: uid, result: result };
      if (edited != null && edited !== it.text) patch.text = String(edited).slice(0, 2000);
      await window.updateDoc(window.doc(window.db || window._db, COLL, id), patch);
      _items = _items.filter((x) => x.id !== id);
      return true;
    } catch (e) {
      if (window.showToast) window.showToast('Could not save: ' + ((e && (e.code || e.message)) || 'error'), 'error');
      return false;
    } finally { _busy = false; }
  }

  // One at a time (Jo, 2026-10-02): the inbox as a swipe deck — right adds the
  // item to the customer's card (or "Got it" for a report), left = later,
  // ⋯ = Toss. No Undo: adding writes a note / task on the customer.
  function deckCard(it) {
    const flagged = !it.verified && it.quinnNote;
    return '<div><span class="deck-tag">' + esc(KINDS[it.kind] || it.kind) + '</span></div>' +
      (it.leadId ? '<div class="deck-name">' + esc(leadName(it.leadId)) + '</div>' : '') +
      '<div class="deck-sub">from ' + esc(it.bot || 'Agent') + (it.kind === 'reminder' && it.dueDate ? ' · due ' + esc(it.dueDate) : '') +
        ' · ' + (it.verified ? '✓ checked by ' + esc(it.verifiedBy || 'Quinn') : flagged ? '⚠ flagged by ' + esc(it.verifiedBy || 'Quinn') : 'unverified') + '</div>' +
      (it.quinnNote ? '<div class="deck-why">' + esc((it.verified ? 'Quinn: ' : '⚠ Quinn: ') + it.quinnNote) + '</div>' : '') +
      (it.title ? '<div class="deck-big">' + esc(it.title) + '</div>' : '') +
      '<div class="deck-why">' + esc(it.text || '') + '</div>';
  }
  function openDeck() {
    if (!window.NBDTriageDeck) return;
    const decideOrThrow = async (id, approve) => { if (!(await decide(id, approve))) throw new Error('That did not save — try again.'); };
    const items = sortItems(_items).map((it) => Object.assign({}, it));
    // The inbox overlay sits above the deck's layer: step out of it, and come
    // back (re-read) when the deck closes.
    close();
    window.NBDTriageDeck.open({
      id: 'agent-inbox',
      title: 'Agent inbox',
      items,
      card: deckCard,
      right: (it) => ({ label: it.kind === 'report' ? 'Got it' : 'Add to CRM', act: () => decideOrThrow(it.id, true) }),
      left: { label: 'Later' },
      more: (it) => [{ label: 'Toss', act: () => decideOrThrow(it.id, false) }],
      doneText: 'Inbox clear.',
      onClose: (done) => {
        open();
        if (done) { try { if (typeof window.loadAllTasks === 'function') window.loadAllTasks(); } catch (_) {} }
      },
    });
  }

  async function bulk(onlyChecked) {
    const ids = bulkIds(_items, onlyChecked);
    let ok = 0;
    for (const id of ids) { if (await decide(id, true)) ok++; }
    paint();
    if (window.showToast) window.showToast('Added ' + ok + ' item' + (ok === 1 ? '' : 's') + ' to the CRM', ok ? 'success' : 'error');
    try { if (typeof window.loadAllTasks === 'function') window.loadAllTasks(); } catch (_) {}
  }

  document.addEventListener('click', async (ev) => {
    const t = ev.target.closest && ev.target.closest('[data-ai-act]');
    if (!t) { if (ev.target && ev.target.id === 'aiOverlay') close(); return; }
    const act = t.dataset.aiAct, id = t.dataset.aiId;
    if (act === 'close') return close();
    if (act === 'bulk') return bulk(false);
    if (act === 'bulkChecked') return bulk(true);
    if (act === 'deck') return openDeck();
    if (act === 'conn') { const d = document.getElementById('aiConn'); if (d && !d.open) setTimeout(() => paintConn(null), 0); return; }
    if (act === 'mkkey') {
      t.disabled = true;
      try { const r = await callable('createAgentKey', { botId: id }); await paintConn(r); }
      catch (e) { if (window.showToast) window.showToast('Could not make a key: ' + ((e && e.message) || 'error'), 'error'); t.disabled = false; }
      return;
    }
    if (act === 'revoke') {
      const sure = typeof window.nbdConfirm === 'function' ? await window.nbdConfirm('Revoke this bot key? The bot loses CRM access until you make a new one.') : true;
      if (!sure) return;
      try { await callable('revokeAgentKey', { id }); await paintConn(null); }
      catch (e) { if (window.showToast) window.showToast('Could not revoke: ' + ((e && e.message) || 'error'), 'error'); }
      return;
    }
    if (act === 'copykey') {
      const k = document.getElementById('aiFreshKey');
      try { await navigator.clipboard.writeText(k ? k.textContent : ''); if (window.showToast) window.showToast('Key copied — paste it into the bot’s secure box', 'success'); } catch (_) {}
      return;
    }
    if (act === 'approve' || act === 'dismiss') {
      t.disabled = true;
      const done = await decide(id, act === 'approve');
      if (done) { paint(); if (act === 'approve') { try { if (typeof window.loadAllTasks === 'function') window.loadAllTasks(); } catch (_) {} } }
      else t.disabled = false;
    }
  });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && document.getElementById('aiOverlay')) close(); });

  // Entry points: ?agentInbox=1 (the 🤖 bell notification) and the palette.
  function boot() {
    let tries = 0;
    const want = /[?&]agentInbox=1\b/.test(window.location.search || '');
    const tick = () => {
      if (!(window._user && window.getDocs)) { if (++tries < 60) setTimeout(tick, 500); return; }
      if (window.NBDCommand && typeof window.NBDCommand.registerAction === 'function' && canUse()) {
        window.NBDCommand.registerAction({ id: 'agent-inbox', label: 'Agent inbox (bot team)', icon: '🤖', run: open, keywords: ['agent', 'bot', 'grok', 'inbox', 'marcus', 'quinn'], group: 'Tools' });
      }
      if (want) {
        try { window.history.replaceState({}, '', window.location.pathname + window.location.hash); } catch (_) {}
        open();
      }
    };
    tick();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.NBDAgentInbox = { open, openDeck, close, sortItems, writeFor, bulkIds, KINDS, COLL };
})();
