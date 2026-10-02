/**
 * ask-joe-actions.js — Ask Joe can DO things (Jo, 2026-10-02; idea #1 from
 * the GameForce review: "say it, it's done" — with a confirm before anything
 * leaves the building).
 *
 * The tool list lives server-side (functions/ask-joe-tools.js, toolset
 * 'joe-actions-v1'); this file RUNS the tools in the dashboard as the
 * signed-in user, through the same functions and Firestore rules as tapping
 * the buttons yourself:
 *
 *   find_customer, get_schedule        read — run at once
 *   send_text, add_reminder, move_stage action — a confirm card first
 *
 * ai.js owns the chat loop; this file owns the tools, the cards and the
 * history → API message mapping (tool_use / tool_result pairing).
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  const TOOLSET = 'joe-actions-v1';
  const READ_TOOLS = ['find_customer', 'get_schedule'];
  const ACTION_TOOLS = ['send_text', 'add_reminder', 'move_stage'];
  const MAX_TEXT = 320;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const leads = () => (Array.isArray(window._leads) ? window._leads : []);
  const findLead = (id) => leads().find((l) => l && l.id === id && !l.deleted) || null;
  const leadName = (l) => (l ? (((l.firstName || '') + ' ' + (l.lastName || '')).trim() || l.name || l.address || 'Customer') : 'Customer');
  const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  const fmtDay = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }); };

  // ── history → API messages (pure) ─────────────────────────────────────
  // History entries: {role:'user', content:string} | {role:'joe', content:
  // string|blocks} | {role:'tool', content: tool_result blocks} | {role:'card',…}.
  // Cards are UI only. Every assistant tool_use must be answered by the very
  // next user message; anything left unanswered (a reload mid-card, a user
  // who typed on) gets a synthetic "not run" result so the API never rejects
  // the conversation. The window starts on a real user message.
  function toolUseIds(content) {
    return Array.isArray(content) ? content.filter((b) => b && b.type === 'tool_use').map((b) => b.id) : [];
  }
  function buildApiMessages(history, maxMsgs) {
    const raw = (history || []).filter((m) => m && m.role !== 'card').map((m) => (
      m.role === 'joe' ? { role: 'assistant', content: m.content }
        : m.role === 'tool' ? { role: 'user', content: Array.isArray(m.content) ? m.content : [], _tool: true }
          : { role: 'user', content: String(m.content == null ? '' : m.content) }));
    const out = [];
    for (let i = 0; i < raw.length; i++) {
      const m = raw[i];
      if (m._tool) {
        const prev = out[out.length - 1];
        const want = prev && prev.role === 'assistant' ? toolUseIds(prev.content) : [];
        const blocks = m.content.filter((b) => b && b.type === 'tool_result' && want.indexOf(b.tool_use_id) !== -1);
        if (!want.length || !blocks.length) continue; // orphan result → drop
        want.forEach((id) => { if (!blocks.some((b) => b.tool_use_id === id)) blocks.push(notRun(id)); });
        out.push({ role: 'user', content: blocks });
        continue;
      }
      const prev = out[out.length - 1];
      const pending = prev && prev.role === 'assistant' ? toolUseIds(prev.content) : [];
      if (pending.length) out.push({ role: 'user', content: pending.map(notRun) });
      out.push({ role: m.role, content: m.content });
    }
    // A trailing assistant tool_use with no answer yet stays unanswered only
    // when the caller is about to answer it; otherwise close it.
    // Merge consecutive user messages (tool results then the user's text).
    const merged = [];
    out.forEach((m) => {
      const last = merged[merged.length - 1];
      if (last && last.role === 'user' && m.role === 'user') {
        last.content = toBlocks(last.content).concat(toBlocks(m.content));
      } else merged.push({ role: m.role, content: m.content });
    });
    // Window: the last maxMsgs, starting on a user message that is plain text
    // (not a tool result — its tool_use would be cut off).
    let start = Math.max(0, merged.length - (maxMsgs || 20));
    while (start < merged.length && !(merged[start].role === 'user' && !hasToolResult(merged[start].content))) start++;
    return merged.slice(start);
  }
  function notRun(id) { return { type: 'tool_result', tool_use_id: id, content: 'Not run — the user moved on before confirming.', is_error: true }; }
  function toBlocks(c) { return Array.isArray(c) ? c : [{ type: 'text', text: String(c == null ? '' : c) }]; }
  function hasToolResult(c) { return Array.isArray(c) && c.some((b) => b && b.type === 'tool_result'); }
  function textOf(content) {
    if (typeof content === 'string') return content;
    return Array.isArray(content) ? content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n').trim() : '';
  }

  // ── read tools ────────────────────────────────────────────────────────
  function findCustomer(input) {
    const q = String((input && input.query) || '').trim();
    if (!q) return { error: 'Give a name, street, phone or customer number.' };
    const S = window.NbdGlobalSearch;
    const hits = S && typeof S.searchLeads === 'function' ? S.searchLeads(q) : [];
    const rows = hits.slice(0, 5).map((h) => {
      const l = h.lead || h;
      const ph = String(l.phone || '').replace(/\D/g, '');
      return {
        lead_id: l.id, name: leadName(l), address: l.address || '', customer_number: l.customerId || '',
        stage: (typeof window.stageLabel === 'function' ? window.stageLabel(l.stage) : l.stage) || '',
        phone_on_file: ph.length >= 10, phone_last4: ph ? ph.slice(-4) : '',
      };
    });
    return rows.length ? { matches: rows } : { matches: [], note: 'No customer matched "' + q + '".' };
  }

  async function getSchedule(input) {
    const ymd = String((input && input.date) || '');
    if (!isYmd(ymd)) return { error: 'date must be YYYY-MM-DD' };
    const [y, m, d] = ymd.split('-').map(Number);
    const start = new Date(y, m - 1, d), end = new Date(y, m - 1, d, 23, 59, 59, 999);
    const items = [];
    const uid = window._user && window._user.uid;
    const S = window.NBDSchedule || {};
    try {
      if (typeof S.leadDayItems === 'function') {
        const di = S.leadDayItems(leads(), ymd, new Set());
        (di.timed || []).concat(di.untimed || []).forEach((a) => items.push({ when: a.startTime ? new Date(a.startTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : (a.windowLabel || a.label || 'no set time'), what: a.title || a.label || 'Job', lead_id: a.leadId || a.id || null }));
      }
      if (typeof S.todaysEvents === 'function') {
        S.todaysEvents(uid, leads(), start.getTime()).forEach((e) => items.push({ when: new Date(e.startTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }), what: e.title, lead_id: e.leadId }));
      }
    } catch (e) { /* the rest still answers */ }
    if (uid && window.getDocs && window.query && window.collection && window.where && (window._db || window.db)) {
      try {
        const q = window.query(window.collection(window._db || window.db, 'appointments'), window.where('repUid', '==', uid), window.where('startTime', '>=', start), window.where('startTime', '<=', end));
        const snap = await window.getDocs(q);
        snap.forEach((doc) => {
          const a = doc.data() || {};
          if (a.status === 'cancelled') return;
          const t = a.startTime && a.startTime.toDate ? a.startTime.toDate() : new Date(a.startTime);
          items.push({ when: t.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }), what: a.title || a.attendeeName || 'Appointment', lead_id: a.leadId || null });
        });
      } catch (e) { /* index / offline — answer with what the page has */ }
    }
    return { date: ymd, day: fmtDay(ymd), items: items.length ? items : [], note: items.length ? undefined : 'Nothing on the schedule that day.' };
  }

  async function runRead(name, input) {
    try {
      const r = name === 'find_customer' ? findCustomer(input) : name === 'get_schedule' ? await getSchedule(input) : { error: 'unknown tool' };
      return JSON.stringify(r);
    } catch (e) { return JSON.stringify({ error: (e && e.message) || 'failed' }); }
  }

  // ── action cards ──────────────────────────────────────────────────────
  function stageKey(raw) {
    const k = typeof window.normalizeStage === 'function' ? window.normalizeStage(String(raw || '')) : String(raw || '');
    if (!k) return null;
    const label = typeof window.stageLabel === 'function' ? window.stageLabel(k) : k;
    return (label && label !== k) || k === 'new' || k === 'lost' ? k : null;
  }

  /** What the card says (pure over the page's leads). */
  function describe(name, input) {
    const i = input || {};
    const lead = findLead(i.lead_id);
    if (!lead) return { error: 'That customer is not on your board.' };
    const who = leadName(lead);
    if (name === 'send_text') {
      const ph = String(lead.phone || '').replace(/\D/g, '');
      if (ph.length < 10) return { error: who + ' has no phone number on file.' };
      return { title: 'Text ' + who, sub: '••• ' + ph.slice(-4), message: String(i.message || '').slice(0, MAX_TEXT), confirm: 'Send text' };
    }
    if (name === 'add_reminder') {
      if (!isYmd(i.due_date)) return { error: 'The reminder needs a date.' };
      return { title: 'Reminder on ' + who, sub: 'Due ' + fmtDay(i.due_date), body: String(i.note || '').slice(0, 300), confirm: 'Add reminder' };
    }
    if (name === 'move_stage') {
      const k = stageKey(i.stage);
      if (!k) return { error: '"' + i.stage + '" is not a pipeline stage.' };
      const from = typeof window.stageLabel === 'function' ? window.stageLabel(lead.stage) : lead.stage;
      const to = typeof window.stageLabel === 'function' ? window.stageLabel(k) : k;
      return { title: 'Move ' + who, sub: (from || 'Unknown') + ' → ' + to, stage: k, confirm: 'Move' };
    }
    return { error: 'Unknown action.' };
  }

  function cardHtml(card) {
    const d = describe(card.name, card.input);
    const id = esc(card.id);
    const status = card.status || 'pending';
    let body = '';
    if (d.error && status === 'pending') {
      return '<div class="joe-card is-error" id="joeCard-' + id + '"><div class="joe-card-title">Can’t do that</div><div class="joe-card-sub">' + esc(d.error) + '</div></div>';
    }
    if (card.name === 'send_text') {
      body = status === 'pending'
        ? '<textarea class="joe-card-text" id="joeCardText-' + id + '" maxlength="' + MAX_TEXT + '" rows="4">' + esc(card.editedMessage != null ? card.editedMessage : d.message) + '</textarea>'
        : '<div class="joe-card-quote">' + esc(card.editedMessage != null ? card.editedMessage : d.message) + '</div>';
    } else if (d.body) body = '<div class="joe-card-quote">' + esc(d.body) + '</div>';
    let foot = '';
    if (status === 'pending') {
      foot = '<div class="joe-card-actions"><button type="button" class="joe-card-btn" data-joe-card="cancel" data-card-id="' + id + '">Cancel</button>' +
        '<button type="button" class="joe-card-btn is-primary" data-joe-card="confirm" data-card-id="' + id + '">' + esc(d.confirm || 'Confirm') + '</button></div>';
    } else if (status === 'working') {
      foot = '<div class="joe-card-status">Working…</div>';
    } else {
      foot = '<div class="joe-card-status is-' + esc(status) + '">' + esc(card.resultText || status) + '</div>' +
        (card.undo && status === 'done' ? '<div class="joe-card-actions"><button type="button" class="joe-card-btn" data-joe-card="undo" data-card-id="' + id + '">Undo</button></div>' : '');
    }
    return '<div class="joe-card is-' + esc(status) + '" id="joeCard-' + id + '">' +
      '<div class="joe-card-title">' + esc(d.title || '') + '</div>' +
      (d.sub ? '<div class="joe-card-sub">' + esc(d.sub) + '</div>' : '') + body + foot + '</div>';
  }

  function viewerBlocked() {
    const c = window._userClaims || {};
    return c.role === 'viewer';
  }

  /** Run a confirmed action → { ok, text, undo? } (never throws). */
  async function execute(card) {
    const d = describe(card.name, card.input);
    if (d.error) return { ok: false, text: d.error };
    if (viewerBlocked()) return { ok: false, text: 'Your account is view-only.' };
    const lead = findLead(card.input.lead_id);
    try {
      if (card.name === 'send_text') {
        const msg = String(card.editedMessage != null ? card.editedMessage : d.message).trim().slice(0, MAX_TEXT);
        if (!msg) return { ok: false, text: 'The message is empty.' };
        if (!window.NBDComms || typeof window.NBDComms.sendSMS !== 'function') return { ok: false, text: 'Texting is not loaded on this page.' };
        const r = await window.NBDComms.sendSMS({ to: lead.phone, message: msg, leadId: lead.id, source: 'ask_joe' });
        // nbd-comms.js modes: 'platform' = sent from the business line;
        // 'queued' = stored offline, goes when back online (quiet hours
        // apply); 'sms' = handed to the phone's Messages app.
        if (r && r.success && r.mode === 'platform') return { ok: true, text: 'Sent to ' + leadName(lead) + '.' };
        if (r && r.success && r.mode === 'queued') return { ok: true, text: 'Saved — it sends when you are back online.' };
        if (r && r.success && r.mode === 'sms') return { ok: false, text: 'Opened your Messages app to send it — not sent by the CRM.' };
        return { ok: false, text: 'Not sent: ' + ((r && (r.message || r.error)) || 'unknown error') };
      }
      if (card.name === 'add_reminder') {
        const uid = window._user && window._user.uid;
        if (!uid || !window.addDoc) return { ok: false, text: 'Not signed in.' };
        const note = String(card.input.note || '').trim().slice(0, 300) || 'Follow up';
        await window.addDoc(window.collection(window.db || window._db, 'leads', lead.id, 'tasks'), {
          leadId: lead.id, userId: uid, title: note, text: note, dueDate: card.input.due_date,
          priority: 'normal', notes: 'Added by Ask Joe', done: false,
          createdAt: window.serverTimestamp(), createdBy: (window._user && window._user.email) || 'Ask Joe',
        });
        try { if (typeof window.loadAllTasks === 'function') window.loadAllTasks(); } catch (_) {}
        return { ok: true, text: 'Reminder added for ' + fmtDay(card.input.due_date) + '.' };
      }
      if (card.name === 'move_stage') {
        if (typeof window.moveCard !== 'function') return { ok: false, text: 'The pipeline is not loaded on this page.' };
        const from = lead.stage;
        const moved = await window.moveCard(lead.id, d.stage);
        if (moved === false) return { ok: false, text: 'Not moved (the pipeline refused or you cancelled).' };
        return { ok: true, text: 'Moved to ' + (typeof window.stageLabel === 'function' ? window.stageLabel(d.stage) : d.stage) + '.', undo: { leadId: lead.id, stage: from } };
      }
    } catch (e) {
      return { ok: false, text: 'Failed: ' + ((e && (e.code || e.message)) || 'error') };
    }
    return { ok: false, text: 'Unknown action.' };
  }

  async function undo(card) {
    if (!card.undo || typeof window.moveCard !== 'function') return { ok: false, text: 'Nothing to undo.' };
    const back = await window.moveCard(card.undo.leadId, card.undo.stage);
    return back === false ? { ok: false, text: 'Undo did not go through.' } : { ok: true, text: 'Undone — moved back.' };
  }

  function systemAddendum(now) {
    const d = now ? new Date(now) : new Date();
    const ymd = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    return '\n\nTOOLS (you can act in the CRM):\n' +
      '- Today is ' + d.toLocaleDateString('en-US', { weekday: 'long' }) + ' ' + ymd + '.\n' +
      '- For any person, call find_customer first and use its lead_id. Never invent an id. If several match, ask which one.\n' +
      '- send_text, add_reminder and move_stage show the user a confirm card. Say in one short line what you are about to do. Never say it is done until the tool result says so.\n' +
      '- One action per reply. Texting a whole list is not available yet.\n' +
      '- Texts: short, friendly, from Joe. Never promise to handle or negotiate an insurance claim.';
  }

  window.NBDJoeActions = {
    TOOLSET, READ_TOOLS, ACTION_TOOLS,
    isRead: (n) => READ_TOOLS.indexOf(n) !== -1,
    isAction: (n) => ACTION_TOOLS.indexOf(n) !== -1,
    buildApiMessages, textOf, toolUseIds,
    runRead, describe, cardHtml, execute, undo, systemAddendum,
    _test: { findCustomer, getSchedule, stageKey },
  };
})();
