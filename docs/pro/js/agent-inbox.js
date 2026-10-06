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
 * the CRM never sends anything from here. Text can be edited before
 * approving; "Approve all" clears notes + reminders in one go.
 *
 * Drafts (Jo, 2026-10-06: bots may DRAFT, nothing auto-sends, Jo sends with
 * one tap):
 *   draft_text   → "Text from my phone" is a plain sms: link with the body
 *                  filled in — the owner's own Messages app sends it. The
 *                  tap also tells the server (agentDraftAction 'sent'), which
 *                  marks the item sent_by_owner and writes the sms_log row +
 *                  a customer note.
 *   draft_email  → Copy / "Open in Mail" (mailto:) / "Mark sent" (same log).
 *   social_draft → "Send to Social Studio" creates a Social Studio DRAFT
 *                  (companies/{id}/social_posts, status 'draft'); approving
 *                  and posting stay in Social Studio.
 * The recipient comes from agentDraftAction 'check' when the inbox opens,
 * which re-reads the Do-Not-Text / unsubscribe lists; a draft that fails it
 * shows why and has no send button.
 *
 * Opens from: the 🤖 Agent inbox nav entry (sidebar AI TOOLS + the phone
 * More drawer, shown to the owner / an admin), a 🤖 bell notification
 * (?agentInbox=1), the command palette ("Agent inbox"), or
 * window.NBDAgentInbox.open(). Owner / company_admin only (Firestore rules
 * enforce it; others see nothing).
 *
 * Bots and their keys are managed on Settings → 🤖 Bots & API
 * (agent-bots-settings.js, 2026-10-04): any company on a paid plan connects
 * its own bots there; the inbox links to it.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  const COLL = 'agent_inbox';
  const KINDS = { note: '📝 Note', reminder: '⏰ Reminder', report: '📄 Report', draft_text: '💬 Text draft', draft_email: '✉️ Email draft', social_draft: '📣 Social draft' };
  const DRAFTS = ['draft_text', 'draft_email', 'social_draft'];
  const isDraft = (it) => !!it && DRAFTS.indexOf(it.kind) !== -1;
  let _items = [];
  let _checks = {};
  let _busy = false;
  let _socialSent = false;

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
    const rank = { reminder: 0, draft_text: 1, draft_email: 2, note: 3, social_draft: 4, report: 5 };
    return (items || []).slice().sort((a, b) =>
      (rank[a.kind] ?? 6) - (rank[b.kind] ?? 6)
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

  // ── Drafts (pure helpers, unit-tested) ───────────────────────────────
  /** iPhone / iPad (incl. iPadOS that reports as a Mac with touch). */
  function isIOS(ua, touchPoints) {
    const u = String(ua || '');
    return /iPhone|iPad|iPod/.test(u) || (/Macintosh/.test(u) && Number(touchPoints) > 1);
  }
  /** sms: link with the body filled in. iOS takes "sms:NUMBER&body=", Android "sms:NUMBER?body=". */
  function smsHref(to, body, ios) {
    const num = String(to || '').replace(/[^\d+]/g, '');
    return 'sms:' + num + (ios ? '&' : '?') + 'body=' + encodeURIComponent(String(body || ''));
  }
  function mailtoHref(to, subject, body) {
    return 'mailto:' + encodeURIComponent(String(to || '')).replace(/%40/g, '@') + '?subject=' + encodeURIComponent(String(subject || '')) + '&body=' + encodeURIComponent(String(body || ''));
  }
  /** The Social Studio draft a social_draft item becomes (pure). Rules: status 'draft', no server-only keys. */
  function socialPostFor(item, uid, companyId, caption) {
    const text = String(caption != null ? caption : item.text || '').trim();
    if (!text) return { error: 'Empty caption' };
    if (!item.platform) return { error: 'No platform on this draft' };
    return { data: {
      kind: 'tip', platform: String(item.platform), format: 'text', caption: text, hashtags: [], media: [],
      town: '', state: '', packageLabel: '', shingle: '', status: 'draft', captionFilter: { dropped: 0 },
      companyId, createdBy: uid, groupId: null, source: 'agent', agentItemId: item.id, agentBot: String(item.bot || 'Agent'),
      brand: item.brand || null, agentMediaUrl: item.mediaUrl || null, requestedFor: item.scheduledFor || null,
    } };
  }
  const safeHttps = (u) => typeof u === 'string' && /^https:\/\/[^\s"'<>]+$/.test(u);
  function iosNow() { try { return isIOS(navigator.userAgent, navigator.maxTouchPoints); } catch (_) { return false; } }

  async function callable(name, payload) {
    if (!window._httpsCallable) {
      const mod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js');
      window._httpsCallable = mod.httpsCallable;
    }
    if (!window._functions) throw new Error('Functions SDK unavailable');
    const res = await window._httpsCallable(window._functions, name)(payload || {});
    return res && res.data;
  }
  async function checkDrafts(items) {
    const ids = items.filter((i) => i.kind === 'draft_text' || i.kind === 'draft_email').map((i) => i.id);
    if (!ids.length) return {};
    try { return ((await callable('agentDraftAction', { action: 'check', ids })) || {}).results || {}; } catch (e) {
      const out = {}; ids.forEach((id) => { out[id] = { ok: false, reason: 'Could not check the Do-Not-Text / unsubscribe lists — try again.' }; }); return out;
    }
  }

  function draftRowHtml(it, chk, ios) {
    const id = esc(it.id);
    const c = chk || {};
    const name = c.name || leadName(it.leadId);
    const head = '<div class="ai-top"><span class="ai-kind">' + esc(KINDS[it.kind] || it.kind) + '</span>' +
      '<span class="ai-cust">' + esc(it.leadId ? name : (it.title || '')) + '</span></div>' +
      '<div class="ai-meta">drafted by ' + esc(it.bot || 'Agent') + (it.kind === 'draft_text' ? ' · ' + (it.consentOnFile ? '<span class="ai-ok">texting consent on file</span>' : '<span class="ai-unv">no written texting consent on file — a one-to-one text from your phone</span>') : '') + '</div>' +
      (it.reason ? '<div class="ai-qnote">Why: ' + esc(it.reason) + '</div>' : '') +
      (it.quinnNote ? '<div class="ai-qnote">' + esc((it.verified ? 'Quinn: ' : '⚠ Quinn: ') + it.quinnNote) + '</div>' : '');
    const toss = '<button type="button" class="ai-btn" data-ai-act="dismiss" data-ai-id="' + id + '">Toss</button>';
    const blocked = c.ok ? '' : '<div class="ai-flag ai-draft-block">' + esc(c.reason || 'Checking the Do-Not-Text / unsubscribe lists…') + '</div>';
    if (it.kind === 'draft_text') {
      const send = c.ok ? '<a class="ai-btn is-primary" id="aiSend-' + id + '" data-ai-act="text" data-ai-id="' + id + '" href="' + esc(smsHref(c.to, it.text, ios)) + '">Text from my phone</a>'
        : '<button type="button" class="ai-btn is-primary" disabled>Text from my phone</button>';
      return '<div class="ai-item" id="aiItem-' + id + '">' + head + blocked +
        '<textarea class="ai-text" id="aiText-' + id + '" data-ai-draft="' + id + '" rows="4" maxlength="1600">' + esc(it.text || '') + '</textarea>' +
        '<div class="ai-actions">' + toss + send + '</div></div>';
    }
    if (it.kind === 'draft_email') {
      const mail = c.ok ? '<a class="ai-btn" id="aiSend-' + id + '" data-ai-act="mail" data-ai-id="' + id + '" href="' + esc(mailtoHref(c.to, it.title, it.text)) + '">Open in Mail</a>'
        : '<button type="button" class="ai-btn" disabled>Open in Mail</button>';
      return '<div class="ai-item" id="aiItem-' + id + '">' + head + blocked +
        (it.fromAddress ? '<div class="ai-meta">Send from ' + esc(it.fromAddress) + '</div>' : '') +
        '<input class="ai-text ai-subj" id="aiSubj-' + id + '" data-ai-draft="' + id + '" maxlength="200" aria-label="Subject" value="' + esc(it.title || '') + '">' +
        '<textarea class="ai-text" id="aiText-' + id + '" data-ai-draft="' + id + '" rows="6" maxlength="2000">' + esc(it.text || '') + '</textarea>' +
        '<div class="ai-actions">' + toss + '<button type="button" class="ai-btn" data-ai-act="copy" data-ai-id="' + id + '">Copy</button>' + mail +
        '<button type="button" class="ai-btn is-primary" data-ai-act="mailsent" data-ai-id="' + id + '"' + (c.ok ? '' : ' disabled') + '>Mark sent</button></div></div>';
    }
    // social_draft — no customer, no recipient check.
    const media = it.mediaUrl && safeHttps(it.mediaUrl) ? '<div class="ai-meta">Media: <a href="' + esc(it.mediaUrl) + '" target="_blank" rel="noopener noreferrer">' + esc(it.mediaUrl) + '</a></div>' : '';
    return '<div class="ai-item" id="aiItem-' + id + '">' + head +
      media + (it.scheduledFor ? '<div class="ai-meta">Wished-for date: ' + esc(it.scheduledFor) + '</div>' : '') +
      '<textarea class="ai-text" id="aiText-' + id + '" rows="5" maxlength="5000">' + esc(it.text || '') + '</textarea>' +
      '<div class="ai-actions">' + toss + '<button type="button" class="ai-btn is-primary" data-ai-act="social" data-ai-id="' + id + '">Send to Social Studio</button></div></div>';
  }

  // The owner tapped send (text) or "Mark sent" (email): the server marks it
  // and writes the Communication Log row + a note. The Messages / Mail app
  // already has the message — nothing is sent from here.
  async function markSent(id) {
    const it = _items.find((x) => x.id === id);
    if (!it) return false;
    const ta = document.getElementById('aiText-' + id);
    const sj = document.getElementById('aiSubj-' + id);
    try {
      await callable('agentDraftAction', { action: 'sent', id, body: ta ? ta.value : it.text, subject: sj ? sj.value : it.title });
      _items = _items.filter((x) => x.id !== id);
      if (window.showToast) window.showToast('Logged on ' + ((_checks[id] && _checks[id].name) || 'the customer') + '’s card', 'success');
      return true;
    } catch (e) {
      if (window.showToast) window.showToast('Not logged yet: ' + ((e && (e.message || e.code)) || 'error'), 'error');
      return false;
    }
  }
  async function toSocial(id) {
    const it = _items.find((x) => x.id === id);
    const key = companyKey();
    if (!it || !key || _busy) return false;
    _busy = true;
    try {
      const uid = window._user && window._user.uid;
      const ta = document.getElementById('aiText-' + id);
      const w = socialPostFor(it, uid, key, ta ? ta.value : null);
      if (w.error) { if (window.showToast) window.showToast(w.error, 'error'); return false; }
      const db = window.db || window._db;
      const ref = await window.addDoc(window.collection(db, 'companies', key, 'social_posts'), Object.assign({}, w.data, { createdAt: window.serverTimestamp(), updatedAt: window.serverTimestamp() }));
      await window.updateDoc(window.doc(db, COLL, id), { status: 'approved', decidedAt: window.serverTimestamp(), decidedBy: uid, result: 'social:' + (ref && ref.id), text: w.data.caption.slice(0, 2000) });
      _items = _items.filter((x) => x.id !== id);
      if (window.showToast) window.showToast('In Social Studio as a draft — approve it there', 'success');
      return true;
    } catch (e) {
      if (window.showToast) window.showToast('Could not save: ' + ((e && (e.code || e.message)) || 'error'), 'error');
      return false;
    } finally { _busy = false; }
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
    if (isDraft(it)) return draftRowHtml(it, _checks[it.id], iosNow());
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
    // Drafts need their send buttons, so the deck takes the rest.
    const deckable = pend.filter((i) => !isDraft(i)).length;
    const deckBtn = document.getElementById('aiDeck');
    if (deckBtn) { deckBtn.hidden = !(window.NBDTriageDeck && deckable > 1); deckBtn.textContent = 'One at a time (' + deckable + ')'; }
    const social = document.getElementById('aiSocialLink');
    if (social) social.hidden = !_socialSent;
    list.innerHTML = pend.length ? pend.map(rowHtml).join('')
      : '<div class="ai-empty">Nothing waiting. When the bots file notes, reminders, reports or drafts, they show up here for you to add to the CRM, send yourself, or toss.</div>';
  }

  async function open() {
    if (!canUse()) { if (window.showToast) window.showToast('The Agent inbox is for the owner or an admin', 'error'); return; }
    close();
    // Opened from the phone More drawer: step out of it first.
    try { if (typeof window.closeMobileMore === 'function') window.closeMobileMore(); } catch (_) {}
    const ov = document.createElement('div');
    ov.className = 'ai-overlay'; ov.id = 'aiOverlay';
    ov.innerHTML = '<div class="ai-modal" role="dialog" aria-modal="true" aria-labelledby="aiTitle">' +
      '<div class="ai-head"><div><h2 class="ai-h" id="aiTitle">🤖 Agent inbox</h2><div class="ai-sub" id="aiCount">Loading…</div></div>' +
      '<button type="button" class="ai-close" data-ai-act="close" aria-label="Close">✕</button></div>' +
      '<p class="ai-note">Your bot team files notes, reminders, reports and drafts here. Nothing reaches a customer unless you send it yourself — a text draft opens in your own Messages app, an email in your own Mail. Edit before adding or sending.</p>' +
      '<button type="button" class="ai-btn ai-bulk" id="aiDeck" data-ai-act="deck" hidden></button>' +
      '<button type="button" class="ai-btn is-primary ai-bulk" id="aiBulkChecked" data-ai-act="bulkChecked" hidden></button>' +
      '<button type="button" class="ai-btn is-primary ai-bulk" id="aiBulk" data-ai-act="bulk" hidden></button>' +
      '<div id="aiList"></div>' +
      '<a class="ai-btn ai-conn-link" id="aiSocialLink" href="/pro/social.html" hidden>📣 Open Social Studio</a>' +
      '<button type="button" class="ai-btn ai-conn-link" data-ai-act="bots">🔌 Bots &amp; API — connect a bot, keys</button>' +
      '</div>';
    document.body.appendChild(ov);
    try { _items = await load(); } catch (e) { _items = []; console.warn('[agent-inbox] load failed:', (e && (e.code || e.message)) || e); }
    _checks = {};
    paint();
    if (_items.some((i) => i.kind === 'draft_text' || i.kind === 'draft_email')) { _checks = await checkDrafts(_items); paint(); }
  }
  function close() { const o = document.getElementById('aiOverlay'); if (o) o.remove(); }

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
    const items = sortItems(_items).filter((it) => !isDraft(it)).map((it) => Object.assign({}, it));
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
    if (act === 'bots') {
      close();
      if (window.NBDAgentBots && typeof window.NBDAgentBots.open === 'function') window.NBDAgentBots.open();
      return;
    }
    // A text draft's link opens the owner's Messages app by itself (no
    // preventDefault); the tap is also the "I sent it" record.
    if (act === 'text' || act === 'mailsent') {
      if (t.dataset.aiSending) return;
      t.dataset.aiSending = '1';
      if (await markSent(id)) paint(); else delete t.dataset.aiSending;
      return;
    }
    if (act === 'mail') return;
    if (act === 'copy') {
      const sj = document.getElementById('aiSubj-' + id), ta = document.getElementById('aiText-' + id);
      try { await navigator.clipboard.writeText((sj && sj.value ? 'Subject: ' + sj.value + '\n\n' : '') + (ta ? ta.value : '')); if (window.showToast) window.showToast('Copied', 'success'); }
      catch (_) { if (window.showToast) window.showToast('Could not copy — select the text and copy it', 'error'); }
      return;
    }
    if (act === 'social') {
      t.disabled = true;
      if (await toSocial(id)) { _socialSent = true; paint(); } else t.disabled = false;
      return;
    }
    if (act === 'approve' || act === 'dismiss') {
      t.disabled = true;
      const done = await decide(id, act === 'approve');
      if (done) { paint(); if (act === 'approve') { try { if (typeof window.loadAllTasks === 'function') window.loadAllTasks(); } catch (_) {} } }
      else t.disabled = false;
    }
  });
  // Editing a draft keeps its sms: / mailto: link in step with the text.
  document.addEventListener('input', (ev) => {
    const id = ev.target && ev.target.dataset && ev.target.dataset.aiDraft;
    if (!id) return;
    const it = _items.find((x) => x.id === id), c = _checks[id], a = document.getElementById('aiSend-' + id);
    if (!it || !c || !c.ok || !a) return;
    const ta = document.getElementById('aiText-' + id), sj = document.getElementById('aiSubj-' + id);
    a.setAttribute('href', it.kind === 'draft_text' ? smsHref(c.to, ta ? ta.value : it.text, iosNow()) : mailtoHref(c.to, sj ? sj.value : it.title, ta ? ta.value : it.text));
  });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && document.getElementById('aiOverlay')) close(); });

  // Entry points: ?agentInbox=1 (the 🤖 bell notification) and the palette.
  function boot() {
    let tries = 0;
    const want = /[?&]agentInbox=1\b/.test(window.location.search || '');
    const tick = () => {
      if (!(window._user && window.getDocs)) { if (++tries < 60) setTimeout(tick, 500); return; }
      if (window.NBDCommand && typeof window.NBDCommand.registerAction === 'function' && canUse()) {
        window.NBDCommand.registerAction({ id: 'agent-inbox', label: 'Agent inbox (bots)', icon: '🤖', run: open, keywords: ['agent', 'bot', 'grok', 'inbox', 'marcus', 'quinn', 'mcp'], group: 'Tools' });
        window.NBDCommand.registerAction({ id: 'agent-bots', label: 'Bots & API settings', icon: '🔌', run: () => { if (window.NBDAgentBots) window.NBDAgentBots.open(); }, keywords: ['bot', 'api', 'mcp', 'key', 'claude', 'chatgpt', 'grok'], group: 'Tools' });
      }
      // The nav entries are hidden until we know the reader may open it.
      if (canUse()) ['nav-agentinbox', 'mm-agentinbox'].forEach((id) => { const el = document.getElementById(id); if (el) el.classList.remove('dn'); });
      if (want) {
        try { window.history.replaceState({}, '', window.location.pathname + window.location.hash); } catch (_) {}
        open();
      }
    };
    tick();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.NBDAgentInbox = { open, openDeck, close, sortItems, writeFor, bulkIds, KINDS, COLL, isIOS, smsHref, mailtoHref, socialPostFor, draftRowHtml, rowHtml };
})();
