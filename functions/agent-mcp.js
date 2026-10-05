'use strict';
/**
 * agent-mcp.js — the CRM connection for bots (MCP over HTTPS). Built for Jo's
 * Grok Bot team (2026-10-02); since 2026-10-04 any NBD Pro company on a paid
 * plan can connect its OWN bots from Settings → Bots & API.
 *
 *   crmMcp            MCP (JSON-RPC over HTTPS, JSON responses) at /api/mcp.
 *                     Auth: "Authorization: Bearer nbdk_…" — one key per bot,
 *                     stored only as a SHA-256 hash in agent_keys/{hash}.
 *   createAgentKey    mint a key for one bot (shown once): a company bot or
 *                     the house roster (owner / company_admin), or a personal
 *                     tracker bot (the signed-in person, for themselves)
 *   listAgentKeys     the Bots & API page: the caller's keys (an owner / admin
 *                     sees every company key), the company's bots, switch,
 *                     plan, timezone and house rules — never a secret
 *   revokeAgentKey    turn one key off (an admin: any company key; anyone:
 *                     their own)
 *   saveAgentBot      owner / admin: make or edit a company bot (name, what it
 *                     does, allowed tools, who its filings notify)
 *   deleteAgentBot    owner / admin: remove a company bot + revoke its keys
 *   saveAgentSettings owner / admin: the company's on/off switch, timezone and
 *                     house rules for bots
 *
 * Every tool is in agent-mcp-logic.js (pure). Bots READ minimized CRM data
 * and FILE notes / reminders / reports into agent_inbox (the owner decides in
 * the CRM's Agent inbox). There is no tool that texts, emails, charges, edits
 * a customer or deletes anything.
 *
 * Gates, in order: the global kill switch (AGENT_MCP_DISABLED=true), the key
 * (active, its bot known and — for a company bot — still active in the same
 * company), the company's own switch (agent_settings/{companyId}.enabled),
 * then the plan (an active / trialing paid plan; NBD and personal tracker
 * keys exempt), then a per-key rate limit.
 *
 * Tenancy: the company comes ONLY from the key doc; no tool takes a company
 * argument. Timezone, the rules tool and who gets the bell all come from that
 * company (companyProfile / companies / agent_settings), never from NBD.
 */
const crypto = require('crypto');
const { onRequest, onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { enforceRateLimit } = require('./integrations/upstash-ratelimit');
const L = require('./agent-mcp-logic');
const SW = require('./schedule-window');

const NBD_OWNER_UID = process.env.NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';
const CALLS_PER_HOUR = 150;
const FILINGS_PER_DAY = 150;
const MCP_PATH = '/api/mcp';
const MCP_URL = 'https://nobigdealwithjoedeal.com' + MCP_PATH;
const CORS_ORIGINS = ['https://nobigdealwithjoedeal.com', 'https://www.nobigdealwithjoedeal.com', 'https://nobigdeal-pro.web.app'];
const MAX_HOUSE_RULES = 3000;

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const db = () => getFirestore();
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

async function readDoc(path) {
  try {
    const s = await db().doc(path).get();
    return s.exists ? (s.data() || {}) : null;
  } catch (e) {
    logger.warn('[crmMcp] read failed', { path: path.split('/')[0], msg: e.message });
    return null;
  }
}

// The company owner: companies/{id}.ownerId, else the id itself (solo /
// self-serve convention: companyId == the owner's uid).
async function companyOwnerUid(companyId) {
  const co = await readDoc('companies/' + companyId);
  const o = co && (co.ownerId || co.ownerUid);
  return o ? String(o) : companyId;
}

function isNbdKey(key) { return key.companyId === NBD_OWNER_UID || key.createdBy === NBD_OWNER_UID; }

/**
 * Everything a call needs about its key's company, read once per request:
 * the bot, NBD or not, the profile (timezone, rules), the company's bot
 * settings, and who the bot works for (routeUid): the company owner, or — for
 * a company bot set to "me" — the person who made it. That person gets the
 * 🤖 bell and their Cal.com appointments fill `schedule`.
 */
async function contextFor(key) {
  if (key && key.bot && key.routeUid) return key;
  const bot = (key && key.bot) || (hasOwn(L.BOTS, key && key.botId) ? Object.assign({ id: key.botId, house: true }, L.BOTS[key.botId]) : null);
  if (!bot) return null;
  const company = key.companyId;
  const isNbd = isNbdKey(key);
  const [profile, settings, owner] = await Promise.all([
    readDoc('companyProfile/' + company), readDoc('agent_settings/' + company),
    companyOwnerUid(company),
  ]);
  const routeUid = bot.custom && bot.routeTo === 'creator' && bot.createdBy ? bot.createdBy : owner;
  const zone = L.companyTimeZone(profile, isNbd, settings && settings.timezone);
  return Object.assign({}, key, { bot, isNbd, profile: profile || {}, settings: settings || {}, routeUid, tz: zone.tz, tzSet: zone.set });
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

// The company's own bots (agent_bots, server-only), keyed 'c_<id>'.
async function companyBots(companyId) {
  const s = await db().collection('agent_bots').where('companyId', '==', companyId).limit(200).get();
  return s.docs.map((d) => ({ id: d.id, data: d.data() || {} }));
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
  const tz = key.tz;
  const today = L.dayInZone(Date.now(), tz);
  if (name === 'crm_summary') return L.toolText(Object.assign(L.summary(await companyLeads(company), today), { today, timezone: tz }));
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
      // The Cal.com bookings of the person this bot works for (key.routeUid):
      // the company owner, or the bot's maker. Written as repUid by the
      // webhook, userId by older paths — read both (morning-brief does too).
      const who = key.routeUid;
      const from = new Date(SW.localToUtcMs(date, '00:00', tz)), to = new Date(SW.localToUtcMs(date, '23:59', tz));
      const [byRep, byUser] = await Promise.all([
        db().collection('appointments').where('repUid', '==', who).where('startTime', '>=', from).where('startTime', '<=', to).get(),
        db().collection('appointments').where('userId', '==', who).where('startTime', '>=', from).where('startTime', '<=', to).get(),
      ]);
      const seen = {};
      byRep.docs.concat(byUser.docs).forEach((d) => {
        if (seen[d.id]) return; seen[d.id] = true;
        const a = d.data();
        if (a.status === 'cancelled') return;
        const t = L.ms(a.startTime);
        items.push({ what: 'Appointment', lead_id: a.leadId || null, name: a.attendeeName || a.title || 'Appointment', start: t ? new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(t)) : null });
      });
    } catch (e) { logger.warn('[crmMcp] appointments read failed', { msg: e.message }); }
    return L.toolText({ date, timezone: tz, items });
  }

  if (name === 'file_note' || name === 'file_reminder' || name === 'file_report') {
    let exists = false;
    if (name !== 'file_report') exists = !!L.activeLeads(await companyLeads(company)).find((l) => l.id === String(args.lead_id || ''));
    const v = L.validateFiling(name, args, exists);
    if (v.error) return L.toolErr(v.error);
    const wording = L.claimWordingProblem(v.item.text) || L.claimWordingProblem(v.item.title);
    if (wording) return L.toolErr(wording);
    const day = today;
    const keyRef = db().collection('agent_keys').doc(key.id);
    const counted = await db().runTransaction(async (tx) => {
      const k = await tx.get(keyRef);
      const n = Number(((k.data() || {}).filedByDay || {})[day]) || 0;
      if (n >= FILINGS_PER_DAY) return false;
      tx.update(keyRef, { ['filedByDay.' + day]: n + 1 });
      return true;
    });
    if (!counted) return L.toolErr('Daily filing limit reached (' + FILINGS_PER_DAY + '). File the rest tomorrow.');
    const bot = key.bot;
    const ref = await db().collection('agent_inbox').add(Object.assign({
      companyId: company, bot: bot.name, botId: key.botId, status: 'pending', verified: false, createdAt: FieldValue.serverTimestamp(), keyId: key.id.slice(0, 12),
    }, v.item));
    await bellNotice(company, key.routeUid, key.botId, bot.name, day).catch((e) => logger.warn('[crmMcp] bell notice failed', { msg: e.message }));
    return L.toolText({ filed: true, item_id: ref.id, kind: v.item.kind, note: 'In your Agent inbox for the owner to review. Nothing was sent to anyone.' });
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
    return L.toolText(L.collectedRevenue(invoices, leads, from, to, tz));
  }

  // The company's own rules (NBD's for NBD; any other company its own
  // profile rules + house rules, else neutral guidance — never NBD's).
  if (name === 'rules_reference') return L.toolText(L.rulesReferenceFor({ isNbd: key.isNbd, profile: key.profile, houseRules: (key.settings || {}).houseRules }));

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
    const [audits, items, own] = await Promise.all([
      db().collection('agent_audit').where('companyId', '==', company).limit(5000).get(),
      db().collection('agent_inbox').where('companyId', '==', company).limit(5000).get(),
      companyBots(company),
    ]);
    // The roster: NBD's house team for NBD, plus the company's own bots.
    const roster = {};
    if (key.isNbd) Object.keys(L.BOTS).forEach((id) => { roster[id] = L.BOTS[id]; });
    own.filter((b) => b.data.active === true).forEach((b) => { roster[L.customBotKey(b.id)] = { name: L.customBotView(b.id, b.data).name, scope: 'crm' }; });
    return L.toolText(L.teamActivity(audits.docs.map((d) => d.data()), items.docs.map((d) => d.data()), Date.now(), args.days, roster));
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
    if (it.status !== 'pending') return L.toolErr('already decided by the owner');
    await ref.update({ verified: !!args.ok, verifiedBy: key.bot.name, quinnNote: String(args.note || '').slice(0, 500), verifiedAt: FieldValue.serverTimestamp() });
    return L.toolText({ ok: true, item_id: snap.id, verified: !!args.ok });
  }
  return L.toolErr('unknown tool');
}

// One bell notification per bot per day, counting what it filed — to the
// person the bot works for (the owner, or the bot's maker), not to the
// company id (a team company's id is not always a person).
async function bellNotice(company, toUid, botId, botName, day) {
  const ref = db().doc('notifications/agentinbox_' + company + '_' + botId + '_' + day);
  await db().runTransaction(async (tx) => {
    const s = await tx.get(ref);
    const n = (s.exists ? Number(s.data().count) || 0 : 0) + 1;
    tx.set(ref, {
      userId: toUid || company, companyId: company, type: 'agent_inbox', priority: 'normal',
      title: '🤖 ' + botName + ' filed ' + (n === 1 ? 'an item' : n + ' items'),
      message: n + ' new item' + (n === 1 ? '' : 's') + ' in your Agent inbox — notes and reminders to review.',
      count: n, read: false, dismissed: false,
      createdAt: s.exists ? s.data().createdAt : FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  });
}

async function handleRpc(msg, keyIn) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return L.rpcError(msg && msg.id, -32600, 'Invalid request');
  const isNotification = msg.id === undefined || msg.id === null;
  const p = msg.params || {};
  const key = await contextFor(keyIn);
  if (!key) return L.rpcError(msg.id, -32001, 'Key not recognised or revoked');
  switch (msg.method) {
    case 'initialize': return L.rpcResult(msg.id, L.initializeResult(p, key.bot));
    case 'ping': return L.rpcResult(msg.id, {});
    case 'tools/list': return L.rpcResult(msg.id, { tools: L.toolsForBot(key.bot) });
    case 'tools/call': {
      const name = String(p.name || '');
      if (!L.botAllows(key.bot, name)) return L.rpcResult(msg.id, L.toolErr('This tool is not part of your role.'));
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

const refuse = () => ({ status: 401, body: L.rpcError(null, -32001, 'Key not recognised or revoked') });

/** Bearer secret → the resolved key context, or { status, body } to refuse with. */
async function authenticate(raw) {
  const id = sha256(raw);
  const snap = await db().collection('agent_keys').doc(id).get();
  const k = snap.exists ? snap.data() : null;
  if (!k || k.active !== true) return refuse();
  let bot;
  if (k.customBotId) {
    // A company bot's key: the bot must still exist, be active and belong to
    // the key's own company (a key can never borrow another company's bot).
    if (k.scope === 'personal' || k.botId !== L.customBotKey(k.customBotId)) return refuse();
    const b = await readDoc('agent_bots/' + String(k.customBotId).replace(/[^A-Za-z0-9]/g, ''));
    if (!b || b.active !== true || b.companyId !== k.companyId) return refuse();
    bot = L.customBotView(k.customBotId, b);
  } else {
    if (!hasOwn(L.BOTS, k.botId)) return refuse();
    // A personal bot's key must be a personal key with an owner, and a CRM
    // bot's key must not be — a mismatched doc is refused outright.
    if (L.isPersonalBot(k.botId) !== (k.scope === 'personal') || (k.scope === 'personal' && !k.ownerUid)) return refuse();
    bot = Object.assign({ id: k.botId, house: true }, L.BOTS[k.botId]);
  }
  const personal = k.scope === 'personal';
  const key = await contextFor({ id, botId: k.botId, companyId: k.companyId, scope: personal ? 'personal' : 'crm', ownerUid: personal ? k.ownerUid : null, createdBy: k.createdBy || null, bot });
  const sub = (key.isNbd || personal) ? null : await readDoc('subscriptions/' + k.companyId);
  const gate = L.accessDecision({ settings: key.settings, isNbd: key.isNbd, personal, sub });
  if (!gate.ok) return { status: gate.status, body: L.rpcError(null, gate.code, gate.message) };
  return { key, ref: snap.ref };
}

async function handleHttp(req, res) {
  res.set('Cache-Control', 'no-store');
  if (process.env.AGENT_MCP_DISABLED === 'true') { res.status(503).json(L.rpcError(null, -32000, 'The CRM connection is switched off.')); return; }
  if (req.method !== 'POST') { res.set('Allow', 'POST'); res.status(405).end(); return; }
  const m = /^Bearer\s+(nbdk_[A-Za-z0-9_-]{20,80})$/.exec(String(req.get('authorization') || ''));
  if (!m) { res.status(401).json(L.rpcError(null, -32001, 'Missing or bad key')); return; }
  const auth = await authenticate(m[1]);
  if (!auth.key) { res.status(auth.status).json(auth.body); return; }
  const key = auth.key;
  const rl = await enforceRateLimit('agentMcp', key.id, CALLS_PER_HOUR, 3600000).catch((e) => ({ allowed: false, err: e }));
  if (rl && rl.allowed === false) { res.set('Retry-After', '600'); res.status(429).json(L.rpcError(null, -32002, 'Rate limit — slow down')); return; }
  auth.ref.update({ lastUsedAt: FieldValue.serverTimestamp() }).catch(() => {});
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

exports.crmMcp = onRequest(
  { region: 'us-central1', invoker: 'public', maxInstances: 10, concurrency: 20, timeoutSeconds: 30, memory: '256MiB' },
  handleHttp
);

// ── Key + bot management ───────────────────────────────────────────────
function callerOf(request) {
  if (!request || !request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  const c = request.auth.token || {};
  const uid = request.auth.uid;
  const company = c.companyId || uid;
  const ok = c.role === 'admin' || c.role === 'company_admin' || company === uid;
  const isAdmin = ok && c.role !== 'viewer' && c.role !== 'sales_rep';
  return { uid, company, isAdmin, platformAdmin: c.role === 'admin', isNbd: company === NBD_OWNER_UID || uid === NBD_OWNER_UID };
}
function requireKeyAdmin(request) {
  const c = callerOf(request);
  if (!c.isAdmin) throw new HttpsError('permission-denied', 'Only the owner or an admin can manage bots and bot keys.');
  return c;
}
// The company's switch + plan, for making bots and keys (the same decision
// the connection makes on every call).
async function assertBotsAllowed(c) {
  const [settings, sub] = await Promise.all([readDoc('agent_settings/' + c.company), c.isNbd ? null : readDoc('subscriptions/' + c.company)]);
  const gate = L.accessDecision({ settings, isNbd: c.isNbd, sub });
  if (!gate.ok) throw new HttpsError('failed-precondition', gate.message);
}
function cleanId(v, re) { return String(v || '').replace(re, ''); }

async function createKey(request) {
  const botId = String((request.data && request.data.botId) || '');
  const customId = L.customBotIdFromKey(botId);
  const raw = 'nbdk_' + crypto.randomBytes(30).toString('base64url');
  const id = sha256(raw);
  if (customId) {
    const c = requireKeyAdmin(request);
    const b = await readDoc('agent_bots/' + customId);
    if (!b || b.active !== true || b.companyId !== c.company) throw new HttpsError('not-found', 'No such bot.');
    await assertBotsAllowed(c);
    const view = L.customBotView(customId, b);
    await db().collection('agent_keys').doc(id).set({ botId, customBotId: customId, botName: view.name, companyId: c.company, active: true, prefix: raw.slice(0, 9), createdAt: FieldValue.serverTimestamp(), createdBy: c.uid });
    return { key: raw, url: MCP_URL, botName: view.name, tools: view.tools, personal: false };
  }
  if (!hasOwn(L.BOTS, botId)) throw new HttpsError('invalid-argument', 'Unknown bot (Nova never gets an NBD key).');
  // A personal key reads only the signed-in person's own tracker, so the
  // person makes it for themselves; CRM keys stay owner / admin only.
  const personal = L.isPersonalBot(botId);
  let uid, company;
  if (personal) {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
    uid = request.auth.uid; company = (request.auth.token || {}).companyId || uid;
  } else {
    const c = requireKeyAdmin(request);
    // The house roster (Marcus, Quinn, …) is NBD's own team. Every other
    // company makes its own bots on the Bots & API page.
    if (!c.isNbd && !c.platformAdmin) throw new HttpsError('permission-denied', 'That bot belongs to NBD\'s own team. Make your own bot in Settings → Bots & API.');
    ({ uid, company } = c);
  }
  const doc = { botId, botName: L.BOTS[botId].name, companyId: company, active: true, prefix: raw.slice(0, 9), createdAt: FieldValue.serverTimestamp(), createdBy: uid };
  if (personal) Object.assign(doc, { scope: 'personal', ownerUid: uid });
  await db().collection('agent_keys').doc(id).set(doc);
  return { key: raw, url: MCP_URL, botName: L.BOTS[botId].name, tools: L.BOTS[botId].tools, personal };
}

async function listKeys(request) {
  const c = callerOf(request);
  const uid = c.uid;
  const [snap, own, settings, sub, profile] = await Promise.all([
    db().collection('agent_keys').where('companyId', '==', c.company).get(),
    c.isAdmin ? companyBots(c.company) : Promise.resolve([]),
    readDoc('agent_settings/' + c.company),
    c.isNbd ? Promise.resolve(null) : readDoc('subscriptions/' + c.company),
    readDoc('companyProfile/' + c.company),
  ]);
  const canHouse = c.isAdmin && (c.isNbd || c.platformAdmin);
  const zone = L.companyTimeZone(profile, c.isNbd, settings && settings.timezone);
  const botNames = {};
  own.forEach((b) => { botNames[L.customBotKey(b.id)] = L.customBotView(b.id, b.data).name; });
  return {
    url: MCP_URL,
    canManage: c.isAdmin, canHouse, isNbd: c.isNbd,
    enabled: !(settings && settings.enabled === false),
    planOk: c.isNbd || L.planAllowsBots(sub), plan: (sub && sub.plan) || (c.isNbd ? 'nbd' : 'free'),
    timezone: zone.tz, timezoneSet: zone.set,
    houseRules: c.isAdmin ? String((settings && settings.houseRules) || '') : '',
    toolCatalog: L.CUSTOM_TOOLS.map((n) => ({ name: n, description: L.TOOLS[n].description, files: L.WRITES.indexOf(n) !== -1 })),
    // The house roster only for NBD; the personal tracker bots for anyone.
    bots: Object.keys(L.BOTS).filter((id) => canHouse || L.isPersonalBot(id))
      .map((id) => ({ botId: id, name: L.BOTS[id].name, tools: L.BOTS[id].tools, firstWave: L.FIRST_WAVE.indexOf(id) !== -1, personal: L.isPersonalBot(id) })),
    customBots: own.filter((b) => b.data.active === true).map((b) => {
      const v = L.customBotView(b.id, b.data);
      return { botId: v.id, name: v.name, role: v.role, tools: v.tools, routeTo: v.routeTo, mine: v.createdBy === uid, createdAt: L.ms(b.data.createdAt) || null };
    }),
    // An owner / admin sees every company key; anyone else only their own.
    // Someone else's personal keys are theirs alone — never listed to an admin.
    keys: snap.docs.filter((d) => { const k = d.data(); return (k.scope !== 'personal' || k.ownerUid === uid) && (c.isAdmin || k.createdBy === uid || k.ownerUid === uid); })
      .map((d) => { const k = d.data(); return { id: d.id, botId: k.botId, botName: botNames[k.botId] || k.botName, active: !!k.active, prefix: k.prefix, personal: k.scope === 'personal', custom: !!k.customBotId, mine: k.createdBy === uid || k.ownerUid === uid, createdAt: L.ms(k.createdAt) || null, lastUsedAt: L.ms(k.lastUsedAt) || null }; }),
  };
}

async function revokeKey(request) {
  const c = callerOf(request);
  const uid = c.uid;
  const id = cleanId(request.data && request.data.id, /[^a-f0-9]/g);
  if (!id) throw new HttpsError('not-found', 'No such key.');
  const ref = db().collection('agent_keys').doc(id);
  const s = await ref.get();
  if (!s.exists || s.data().companyId !== c.company) throw new HttpsError('not-found', 'No such key.');
  if (s.data().scope === 'personal' && s.data().ownerUid !== uid) throw new HttpsError('not-found', 'No such key.');
  if (!c.isAdmin && s.data().createdBy !== uid && s.data().ownerUid !== uid) throw new HttpsError('not-found', 'No such key.');
  await ref.update({ active: false, revokedAt: FieldValue.serverTimestamp(), revokedBy: uid });
  return { ok: true };
}

async function saveBot(request) {
  const c = requireKeyAdmin(request);
  const data = request.data || {};
  const v = L.normalizeBotInput(data);
  if (v.error) throw new HttpsError('invalid-argument', v.error);
  await assertBotsAllowed(c);
  let botDocId;
  if (data.botId) {
    botDocId = L.customBotIdFromKey(data.botId);
    const cur = botDocId ? await readDoc('agent_bots/' + botDocId) : null;
    if (!cur || cur.active !== true || cur.companyId !== c.company) throw new HttpsError('not-found', 'No such bot.');
    const edit = Object.assign({}, v.bot, { updatedAt: FieldValue.serverTimestamp(), updatedBy: c.uid });
    await db().doc('agent_bots/' + botDocId).update(edit);
  } else {
    const live = (await companyBots(c.company)).filter((b) => b.data.active === true);
    if (live.length >= L.MAX_CUSTOM_BOTS) throw new HttpsError('resource-exhausted', 'A company can have up to ' + L.MAX_CUSTOM_BOTS + ' bots. Remove one first.');
    const ref = db().collection('agent_bots').doc();
    await ref.set(Object.assign({}, v.bot, { companyId: c.company, active: true, createdBy: c.uid, createdAt: FieldValue.serverTimestamp() }));
    botDocId = ref.id;
  }
  // No timezone on the company yet (not NBD): take the owner's browser zone,
  // so "today" and schedule days match where the company works.
  if (!c.isNbd && L.validTimeZone(data.timezone)) {
    const [profile, settings] = await Promise.all([readDoc('companyProfile/' + c.company), readDoc('agent_settings/' + c.company)]);
    if (!L.companyTimeZone(profile, false, settings && settings.timezone).set) await writeTimeZone(c.company, profile, data.timezone);
  }
  return { ok: true, botId: L.customBotKey(botDocId) };
}

// The company's timezone lives on its companyProfile (where the contract
// date logic reads it too). A company with no profile doc yet keeps it on
// agent_settings instead — never a stub profile the rest of the CRM would read.
async function writeTimeZone(company, profile, tz) {
  if (profile) await db().doc('companyProfile/' + company).set({ timezone: tz }, { merge: true });
  else await db().doc('agent_settings/' + company).set({ timezone: tz }, { merge: true });
}

async function deleteBot(request) {
  const c = requireKeyAdmin(request);
  const botDocId = L.customBotIdFromKey(request.data && request.data.botId);
  const cur = botDocId ? await readDoc('agent_bots/' + botDocId) : null;
  if (!cur || cur.companyId !== c.company) throw new HttpsError('not-found', 'No such bot.');
  const removal = { active: false, removedAt: FieldValue.serverTimestamp(), removedBy: c.uid };
  await db().doc('agent_bots/' + botDocId).update(removal);
  const keys = await db().collection('agent_keys').where('customBotId', '==', botDocId).get();
  let revoked = 0;
  for (const d of keys.docs) {
    const k = d.data() || {};
    if (k.companyId !== c.company || k.active !== true) continue;
    await d.ref.update({ active: false, revokedAt: FieldValue.serverTimestamp(), revokedBy: c.uid });
    revoked++;
  }
  return { ok: true, keysRevoked: revoked };
}

async function saveSettings(request) {
  const c = requireKeyAdmin(request);
  const data = request.data || {};
  const patch = { updatedAt: FieldValue.serverTimestamp(), updatedBy: c.uid };
  if (typeof data.enabled === 'boolean') patch.enabled = data.enabled;
  if (typeof data.houseRules === 'string') patch.houseRules = data.houseRules.slice(0, MAX_HOUSE_RULES);
  await db().doc('agent_settings/' + c.company).set(patch, { merge: true });
  if (data.timezone !== undefined && data.timezone !== '') {
    if (!L.validTimeZone(data.timezone)) throw new HttpsError('invalid-argument', 'Not a timezone.');
    await writeTimeZone(c.company, await readDoc('companyProfile/' + c.company), data.timezone);
  }
  return { ok: true };
}

const CALL_OPTS = { region: 'us-central1', cors: CORS_ORIGINS, enforceAppCheck: true, timeoutSeconds: 20, memory: '256MiB' };
exports.createAgentKey = onCall(CALL_OPTS, createKey);
exports.listAgentKeys = onCall(CALL_OPTS, listKeys);
exports.revokeAgentKey = onCall(CALL_OPTS, revokeKey);
exports.saveAgentBot = onCall(CALL_OPTS, saveBot);
exports.deleteAgentBot = onCall(CALL_OPTS, deleteBot);
exports.saveAgentSettings = onCall(CALL_OPTS, saveSettings);

exports._internal = {
  handleRpc, runTool, sha256, contextFor, authenticate, handleHttp, bellNotice,
  createKey, listKeys, revokeKey, saveBot, deleteBot, saveSettings, callerOf, NBD_OWNER_UID,
};
