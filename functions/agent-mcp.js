'use strict';
/**
 * agent-mcp.js — the NBD CRM connection for Jo's Grok Bot team (2026-10-02).
 *
 *   crmMcp            MCP (JSON-RPC over HTTPS, JSON responses) at /api/mcp.
 *                     Auth: "Authorization: Bearer nbdk_…" — one key per bot,
 *                     stored only as a SHA-256 hash in agent_keys/{hash}.
 *   createAgentKey    owner / company_admin mints a key for one bot (shown once)
 *   listAgentKeys     the company's keys (no secrets)
 *   revokeAgentKey    turn one off
 *
 * Every tool is in agent-mcp-logic.js (pure). Bots READ minimized CRM data
 * and FILE notes / reminders / reports into agent_inbox (Jo decides in the
 * CRM's Agent inbox). There is no tool that texts, emails, charges, edits a
 * customer or deletes anything. Kill switch: AGENT_MCP_DISABLED=true.
 */
const crypto = require('crypto');
const { onRequest, onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { enforceRateLimit } = require('./integrations/upstash-ratelimit');
const L = require('./agent-mcp-logic');
const SW = require('./schedule-window');

const TZ = 'America/New_York';
const CALLS_PER_HOUR = 150;
const FILINGS_PER_DAY = 150;
const MCP_PATH = '/api/mcp';
const MCP_URL = 'https://nobigdealwithjoedeal.com' + MCP_PATH;
const CORS_ORIGINS = ['https://nobigdealwithjoedeal.com', 'https://www.nobigdealwithjoedeal.com', 'https://nobigdeal-pro.web.app'];

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const db = () => getFirestore();

function nyToday() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return parts; // YYYY-MM-DD
}

async function companyLeads(companyId) {
  const [a, b] = await Promise.all([
    db().collection('leads').where('companyId', '==', companyId).get(),
    db().collection('leads').where('userId', '==', companyId).get(),
  ]);
  const byId = {};
  a.docs.concat(b.docs).forEach((d) => { byId[d.id] = Object.assign({ id: d.id }, d.data()); });
  return Object.values(byId);
}

// Every doc of a collection owned by the company under any of its owner
// fields (solo accounts own by uid, team accounts by companyId), de-duplicated.
async function companyDocs(collection, companyId, fields) {
  const snaps = await Promise.all(fields.map((f) => db().collection(collection).where(f, '==', companyId).limit(5000).get()));
  const byId = {};
  snaps.forEach((s) => s.docs.forEach((d) => { byId[d.id] = Object.assign({ id: d.id }, d.data()); }));
  return Object.values(byId);
}

async function runTool(name, args, key) {
  // Personal scope: the key owner's own tracker and nothing else. A personal
  // key can never reach a CRM tool, and a CRM key never reaches these
  // (botAllows already splits the lists; this is the second lock).
  if (L.isPersonalTool(name) || key.scope === 'personal') {
    if (key.scope !== 'personal' || !key.ownerUid || !L.isPersonalTool(name)) return L.toolErr('This key cannot use that tool.');
    const s = await db().collection('userSettings').doc(key.ownerUid).get();
    const d = s.exists ? (s.data() || {}) : {};
    if (name === 'my_today') return L.toolText(L.personalToday(d.dsSnapshot, Date.now()));
    if (name === 'my_week') return L.toolText(L.personalWeek(d.dsSnapshot, Date.now()));
    if (name === 'my_reviews') return L.toolText({ reviews: L.personalReviews(d.dsReviews, args.limit) });
    if (name === 'my_money') return L.toolText(L.personalMoney(d.dsSnapshot, Date.now()));
    return L.toolErr('unknown tool');
  }
  const company = key.companyId;
  const today = nyToday();
  if (name === 'crm_summary') return L.toolText(L.summary(await companyLeads(company), today));
  if (name === 'overdue_followups') return L.toolText({ today, customers: L.overdueFollowups(await companyLeads(company), today, args.limit) });
  if (name === 'list_leads') return L.toolText({ customers: L.listLeads(await companyLeads(company), args, Date.now()) });

  if (name === 'lead_detail') {
    const leads = await companyLeads(company);
    const lead = L.activeLeads(leads).find((l) => l.id === String(args.lead_id || ''));
    if (!lead) return L.toolErr('unknown lead_id');
    const [notes, tasks] = await Promise.all([
      db().collection('notes').where('leadId', '==', lead.id).limit(40).get(),
      db().collection('leads').doc(lead.id).collection('tasks').where('done', '==', false).limit(20).get(),
    ]);
    const lastNotes = notes.docs.map((d) => d.data()).sort((x, y) => L.ms(y.createdAt) - L.ms(x.createdAt)).slice(0, 5)
      .map((n) => ({ when: L.ms(n.createdAt) ? new Date(L.ms(n.createdAt)).toISOString().slice(0, 10) : null, text: String(n.text || '').slice(0, 400) }));
    const open = tasks.docs.map((d) => d.data()).map((t) => ({ due: t.dueDate || null, text: String(t.title || t.text || '').slice(0, 200) }));
    return L.toolText(Object.assign(L.minimalLead(lead), { notes: lastNotes, open_reminders: open }));
  }

  if (name === 'schedule') {
    const date = String(args.date || '');
    if (!L.isYmd(date)) return L.toolErr('date must be YYYY-MM-DD');
    const leads = L.activeLeads(await companyLeads(company));
    const items = [];
    leads.forEach((l) => {
      const covers = typeof SW.coversDay === 'function' ? SW.coversDay(l, date) : l.scheduledDate === date;
      if (covers) items.push({ what: 'Job', lead_id: l.id, name: L.minimalLead(l).name, address: l.address || '', start: l.scheduledStart || null });
      if (l.adjusterMeetingDate === date) items.push({ what: 'Adjuster meeting', lead_id: l.id, name: L.minimalLead(l).name, address: l.address || '', start: l.adjusterMeetingStart || null });
      if (l.followUp === date) items.push({ what: 'Follow-up due', lead_id: l.id, name: L.minimalLead(l).name });
    });
    try {
      const from = new Date(SW.localToUtcMs(date, '00:00', TZ)), to = new Date(SW.localToUtcMs(date, '23:59', TZ));
      const appts = await db().collection('appointments').where('repUid', '==', company).where('startTime', '>=', from).where('startTime', '<=', to).get();
      appts.docs.map((d) => d.data()).filter((a) => a.status !== 'cancelled').forEach((a) => {
        const t = L.ms(a.startTime);
        items.push({ what: 'Appointment', lead_id: a.leadId || null, name: a.attendeeName || a.title || 'Appointment', start: t ? new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(new Date(t)) : null });
      });
    } catch (e) { logger.warn('[crmMcp] appointments read failed', { msg: e.message }); }
    return L.toolText({ date, items });
  }

  if (name === 'file_note' || name === 'file_reminder' || name === 'file_report') {
    let exists = false;
    if (name !== 'file_report') exists = !!L.activeLeads(await companyLeads(company)).find((l) => l.id === String(args.lead_id || ''));
    const v = L.validateFiling(name, args, exists);
    if (v.error) return L.toolErr(v.error);
    const wording = L.claimWordingProblem(v.item.text) || L.claimWordingProblem(v.item.title);
    if (wording) return L.toolErr(wording);
    const day = nyToday();
    const keyRef = db().collection('agent_keys').doc(key.id);
    const counted = await db().runTransaction(async (tx) => {
      const k = await tx.get(keyRef);
      const n = Number(((k.data() || {}).filedByDay || {})[day]) || 0;
      if (n >= FILINGS_PER_DAY) return false;
      tx.update(keyRef, { ['filedByDay.' + day]: n + 1 });
      return true;
    });
    if (!counted) return L.toolErr('Daily filing limit reached (' + FILINGS_PER_DAY + '). File the rest tomorrow.');
    const bot = L.BOTS[key.botId];
    const ref = await db().collection('agent_inbox').add(Object.assign({
      companyId: company, bot: bot.name, botId: key.botId, status: 'pending', verified: false, createdAt: FieldValue.serverTimestamp(), keyId: key.id.slice(0, 12),
    }, v.item));
    await bellNotice(company, key.botId, bot.name, day).catch((e) => logger.warn('[crmMcp] bell notice failed', { msg: e.message }));
    return L.toolText({ filed: true, item_id: ref.id, kind: v.item.kind, note: 'In Jo\'s Agent inbox. Nothing was sent to anyone.' });
  }

  if (name === 'estimates_status') {
    const [leads, estimates, deals] = await Promise.all([
      companyLeads(company), companyDocs('estimates', company, ['companyId', 'userId']), companyDocs('deal_rooms', company, ['userId']),
    ]);
    return L.toolText({ estimates: L.estimatesStatus(estimates, deals, leads, args, Date.now()),
      note: 'total_customer_facing is what the homeowner sees. Cost and margin are never shared here.' });
  }

  if (name === 'collected_revenue') {
    const from = args.from ? String(args.from) : today.slice(0, 8) + '01';
    const to = args.to ? String(args.to) : today;
    if (!L.isYmd(from) || !L.isYmd(to) || from > to) return L.toolErr('from/to must be YYYY-MM-DD with from <= to');
    const [leads, invoices] = await Promise.all([companyLeads(company), companyDocs('invoices', company, ['companyId', 'createdBy'])]);
    return L.toolText(L.collectedRevenue(invoices, leads, from, to, TZ));
  }

  if (name === 'rules_reference') return L.toolText(L.rulesReference());

  if (name === 'post_job') {
    const [leads, invoices] = await Promise.all([companyLeads(company), companyDocs('invoices', company, ['companyId', 'createdBy'])]);
    return L.toolText({ jobs: L.postJob(leads, invoices, Date.now(), args) });
  }

  if (name === 'lead_sources') {
    const [leads, expenses] = await Promise.all([companyLeads(company), companyDocs('expenses', company, ['companyId', 'userId'])]);
    return L.toolText(L.leadSources(leads, expenses, Date.now(), args.days));
  }

  if (name === 'job_profit') {
    const [leads, invoices, expenses] = await Promise.all([
      companyLeads(company), companyDocs('invoices', company, ['companyId', 'createdBy']), companyDocs('expenses', company, ['companyId', 'userId']),
    ]);
    return L.toolText(L.jobProfit(leads, invoices, expenses, Date.now(), args));
  }

  if (name === 'storm_near_customers') {
    // storm_events is the shared NWS feed stormWatch writes (no owner); only
    // this company's customers are matched against it.
    const days = Math.min(Math.max(Math.floor(Number(args.days)) || 14, 1), 60);
    const [leads, ev] = await Promise.all([
      companyLeads(company),
      db().collection('storm_events').where('processedAt', '>=', new Date(Date.now() - days * 86400000)).limit(500).get(),
    ]);
    return L.toolText(L.stormNearCustomers(ev.docs.map((d) => d.data()), leads, Date.now(), args));
  }

  if (name === 'team_activity') {
    // Single-field equality reads (no composite index); dates filtered in logic.
    const [audits, items] = await Promise.all([
      db().collection('agent_audit').where('companyId', '==', company).limit(5000).get(),
      db().collection('agent_inbox').where('companyId', '==', company).limit(5000).get(),
    ]);
    return L.toolText(L.teamActivity(audits.docs.map((d) => d.data()), items.docs.map((d) => d.data()), Date.now(), args.days));
  }

  if (name === 'inbox_pending') {
    const snap = await db().collection('agent_inbox').where('companyId', '==', company).where('status', '==', 'pending').limit(L.MAX_LIST).get();
    const items = snap.docs.map((d) => Object.assign({ item_id: d.id }, d.data()))
      .sort((a, b) => L.ms(a.createdAt) - L.ms(b.createdAt)).slice(0, Math.min(Number(args.limit) || 20, L.MAX_LIST))
      .map((i) => ({ item_id: i.item_id, bot: i.bot, kind: i.kind, lead_id: i.leadId || null, due_date: i.dueDate || null, title: i.title || '', text: i.text, verified: !!i.verified, quinn_note: i.quinnNote || '' }));
    return L.toolText({ items });
  }

  if (name === 'verify_item') {
    const ref = db().doc('agent_inbox/' + String(args.item_id || '').replace(/[^A-Za-z0-9_-]/g, ''));
    const snap = await ref.get();
    const it = snap.exists ? snap.data() : null;
    if (!it || it.companyId !== company) return L.toolErr('unknown item_id');
    if (it.status !== 'pending') return L.toolErr('already decided by Jo');
    await ref.update({ verified: !!args.ok, verifiedBy: L.BOTS[key.botId].name, quinnNote: String(args.note || '').slice(0, 500), verifiedAt: FieldValue.serverTimestamp() });
    return L.toolText({ ok: true, item_id: snap.id, verified: !!args.ok });
  }
  return L.toolErr('unknown tool');
}

// One bell notification per bot per day, counting what it filed.
async function bellNotice(company, botId, botName, day) {
  const ref = db().doc('notifications/agentinbox_' + company + '_' + botId + '_' + day);
  await db().runTransaction(async (tx) => {
    const s = await tx.get(ref);
    const n = (s.exists ? Number(s.data().count) || 0 : 0) + 1;
    tx.set(ref, {
      userId: company, type: 'agent_inbox', priority: 'normal',
      title: '🤖 ' + botName + ' filed ' + (n === 1 ? 'an item' : n + ' items'),
      message: n + ' new item' + (n === 1 ? '' : 's') + ' in your Agent inbox — notes and reminders to review.',
      count: n, read: false, dismissed: false,
      createdAt: s.exists ? s.data().createdAt : FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  });
}

async function handleRpc(msg, key) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return L.rpcError(msg && msg.id, -32600, 'Invalid request');
  const isNotification = msg.id === undefined || msg.id === null;
  const p = msg.params || {};
  switch (msg.method) {
    case 'initialize': return L.rpcResult(msg.id, L.initializeResult(p, key.botId));
    case 'ping': return L.rpcResult(msg.id, {});
    case 'tools/list': return L.rpcResult(msg.id, { tools: L.toolsForBot(key.botId) });
    case 'tools/call': {
      const name = String(p.name || '');
      if (!L.botAllows(key.botId, name)) return L.rpcResult(msg.id, L.toolErr('This tool is not part of your role.'));
      let out;
      try { out = await runTool(name, p.arguments || {}, key); }
      catch (e) { logger.error('[crmMcp] tool failed', { name, msg: e.message }); out = L.toolErr('The CRM could not answer right now.'); }
      db().collection('agent_audit').add({ keyId: key.id.slice(0, 12), botId: key.botId, companyId: key.companyId, tool: name, ok: !out.isError, at: FieldValue.serverTimestamp() }).catch(() => {});
      return L.rpcResult(msg.id, out);
    }
    default:
      if (isNotification) return null; // notifications/initialized etc.
      return L.rpcError(msg.id, -32601, 'Method not found');
  }
}

exports.crmMcp = onRequest(
  { region: 'us-central1', invoker: 'public', maxInstances: 10, concurrency: 20, timeoutSeconds: 30, memory: '256MiB' },
  async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (process.env.AGENT_MCP_DISABLED === 'true') { res.status(503).json(L.rpcError(null, -32000, 'The NBD CRM connection is switched off.')); return; }
    if (req.method !== 'POST') { res.set('Allow', 'POST'); res.status(405).end(); return; }
    const m = /^Bearer\s+(nbdk_[A-Za-z0-9_-]{20,80})$/.exec(String(req.get('authorization') || ''));
    if (!m) { res.status(401).json(L.rpcError(null, -32001, 'Missing or bad key')); return; }
    const id = sha256(m[1]);
    const snap = await db().collection('agent_keys').doc(id).get();
    const k = snap.exists ? snap.data() : null;
    if (!k || k.active !== true || !L.BOTS[k.botId]) { res.status(401).json(L.rpcError(null, -32001, 'Key not recognised or revoked')); return; }
    // A personal bot's key must be a personal key with an owner, and a CRM
    // bot's key must not be — a mismatched doc is refused outright.
    if (L.isPersonalBot(k.botId) !== (k.scope === 'personal') || (k.scope === 'personal' && !k.ownerUid)) { res.status(401).json(L.rpcError(null, -32001, 'Key not recognised or revoked')); return; }
    const key = { id, botId: k.botId, companyId: k.companyId, scope: k.scope === 'personal' ? 'personal' : 'crm', ownerUid: k.scope === 'personal' ? k.ownerUid : null };
    const rl = await enforceRateLimit('agentMcp', id, CALLS_PER_HOUR, 3600000).catch((e) => ({ allowed: false, err: e }));
    if (rl && rl.allowed === false) { res.set('Retry-After', '600'); res.status(429).json(L.rpcError(null, -32002, 'Rate limit — slow down')); return; }
    snap.ref.update({ lastUsedAt: FieldValue.serverTimestamp() }).catch(() => {});
    const body = req.body;
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.slice(0, 20).map((m2) => handleRpc(m2, key)))).filter(Boolean);
      if (!out.length) { res.status(202).end(); return; }
      res.status(200).json(out); return;
    }
    const out = await handleRpc(body, key);
    if (!out) { res.status(202).end(); return; }
    res.status(200).json(out);
  }
);

// ── Key management (owner / company_admin) ─────────────────────────────
function requireKeyAdmin(request) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  const c = request.auth.token || {};
  const uid = request.auth.uid;
  const company = c.companyId || uid;
  const ok = c.role === 'admin' || c.role === 'company_admin' || company === uid;
  if (!ok || c.role === 'viewer' || c.role === 'sales_rep') throw new HttpsError('permission-denied', 'Only the owner or an admin can manage bot keys.');
  return { uid, company };
}

exports.createAgentKey = onCall(
  { region: 'us-central1', cors: CORS_ORIGINS, enforceAppCheck: true, timeoutSeconds: 20, memory: '256MiB' },
  async (request) => {
    const botId = String((request.data && request.data.botId) || '');
    if (!Object.prototype.hasOwnProperty.call(L.BOTS, botId)) throw new HttpsError('invalid-argument', 'Unknown bot (Nova never gets an NBD key).');
    // A personal key reads only the signed-in person's own tracker, so the
    // person makes it for themselves; CRM keys stay owner / admin only.
    const personal = L.isPersonalBot(botId);
    let uid, company;
    if (personal) {
      if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
      uid = request.auth.uid; company = (request.auth.token || {}).companyId || uid;
    } else ({ uid, company } = requireKeyAdmin(request));
    const raw = 'nbdk_' + crypto.randomBytes(30).toString('base64url');
    const id = sha256(raw);
    const doc = { botId, botName: L.BOTS[botId].name, companyId: company, active: true, prefix: raw.slice(0, 9), createdAt: FieldValue.serverTimestamp(), createdBy: uid };
    if (personal) Object.assign(doc, { scope: 'personal', ownerUid: uid });
    await db().collection('agent_keys').doc(id).set(doc);
    return { key: raw, url: MCP_URL, botName: L.BOTS[botId].name, tools: L.BOTS[botId].tools, personal };
  }
);

exports.listAgentKeys = onCall(
  { region: 'us-central1', cors: CORS_ORIGINS, enforceAppCheck: true, timeoutSeconds: 20, memory: '256MiB' },
  async (request) => {
    const { uid, company } = requireKeyAdmin(request);
    const snap = await db().collection('agent_keys').where('companyId', '==', company).get();
    return {
      url: MCP_URL,
      bots: Object.keys(L.BOTS).map((id) => ({ botId: id, name: L.BOTS[id].name, tools: L.BOTS[id].tools, firstWave: L.FIRST_WAVE.indexOf(id) !== -1, personal: L.isPersonalBot(id) })),
      // Someone else's personal keys are theirs alone — never listed to an admin.
      keys: snap.docs.filter((d) => { const k = d.data(); return k.scope !== 'personal' || k.ownerUid === uid; })
        .map((d) => { const k = d.data(); return { id: d.id, botId: k.botId, botName: k.botName, active: !!k.active, prefix: k.prefix, personal: k.scope === 'personal', createdAt: L.ms(k.createdAt) || null, lastUsedAt: L.ms(k.lastUsedAt) || null }; }),
    };
  }
);

exports.revokeAgentKey = onCall(
  { region: 'us-central1', cors: CORS_ORIGINS, enforceAppCheck: true, timeoutSeconds: 20, memory: '256MiB' },
  async (request) => {
    const { uid, company } = requireKeyAdmin(request);
    const id = String((request.data && request.data.id) || '').replace(/[^a-f0-9]/g, '');
    const ref = db().collection('agent_keys').doc(id);
    const s = await ref.get();
    if (!s.exists || s.data().companyId !== company) throw new HttpsError('not-found', 'No such key.');
    if (s.data().scope === 'personal' && s.data().ownerUid !== uid) throw new HttpsError('not-found', 'No such key.');
    await ref.update({ active: false, revokedAt: FieldValue.serverTimestamp(), revokedBy: uid });
    return { ok: true };
  }
);

exports._internal = { handleRpc, runTool, sha256, nyToday };
