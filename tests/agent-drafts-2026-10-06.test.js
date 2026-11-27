#!/usr/bin/env node
/**
 * Bot drafts (Jo, 2026-10-06): "bots may DRAFT outbound customer messages;
 * NOTHING ever auto-sends; Jo sends with one tap."
 *
 *   A. pure rules: who gets the draft tools (Marcus + Tucker text/email,
 *      Dana + Priya social, CoS unchanged, company bots never), Frank's
 *      post_job + file_reminder, the STOP line appended once, the company
 *      name required, the 480-character cap, email From, social platforms,
 *      server version 1.3.0 (bumped 2026-10-06 for list_leads paging)
 *   B. the real MCP handler over an in-memory Firestore: a draft lands in
 *      agent_inbox; NO tool answer ever carries the customer's phone or
 *      email; a customer on the Do-Not-Text register (canonical or legacy
 *      key), one who declined on the form, one with no phone, one who
 *      unsubscribed from email are refused; a bot outside the role is refused;
 *      a social draft never touches social_posts
 *   C. agentDraftAction: check re-reads the lists and gives the owner the
 *      recipient; sent writes sms_log / email_log with leadId + uid + date
 *      (the comm-log contract) and a customer note, marks sent_by_owner,
 *      logs once on a double tap; a viewer / sales rep / other company is refused
 *   D. the Agent inbox renders the three kinds: escaped bot text, an sms:
 *      link (iOS "&body=", Android "?body="), mailto:, no send link when the
 *      check fails, a Social Studio draft the rules accept, no inline handlers
 *
 * Run: node tests/agent-drafts-2026-10-06.test.js
 *      (needs functions/node_modules, like agent-tenant-bots-2026-10-04)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Module = require('module');
const vm = require('vm');
const crypto = require('crypto');

// Clock pinned to 12:00 ET on a weekday (still ticking). The owner-send path
// checks the homeowner's texting hours (8am-9pm local) against Date.now(), so
// on the real clock this suite went red every evening after 9pm ET and
// blocked the merge queue (2026-10-07, run 37553484276).
{
  const realNow = Date.now;
  const start = realNow();
  const NOON_ET = Date.parse('2026-10-06T16:00:00Z');
  Date.now = () => NOON_ET + (realNow() - start);
}

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

// ── In-memory Firestore (the agent-tenant-bots-2026-10-04 idiom) ─────────
function fakeDb() {
  const docs = new Map();
  let auto = 0;
  const setDotted = (o, k, v) => { const parts = k.split('.'); let cur = o; for (let i = 0; i < parts.length - 1; i++) { cur[parts[i]] = Object.assign({}, cur[parts[i]] || {}); cur = cur[parts[i]]; } cur[parts[parts.length - 1]] = v; };
  const snap = (p) => ({ id: p.split('/').pop(), ref: mk(p), exists: docs.has(p), data: () => docs.get(p) });
  function mk(p) {
    return {
      id: p.split('/').pop(), path: p,
      get: async () => snap(p),
      set: async (v, o) => { docs.set(p, o && o.merge ? Object.assign({}, docs.get(p) || {}, v) : Object.assign({}, v)); },
      update: async (v) => {
        if (!docs.has(p)) { const e = new Error('NOT_FOUND ' + p); e.code = 5; throw e; }
        const cur = Object.assign({}, docs.get(p)); Object.keys(v).forEach((k) => setDotted(cur, k, v[k])); docs.set(p, cur);
      },
      collection: (n) => coll(p + '/' + n),
    };
  }
  const val = (x) => (x instanceof Date ? x.getTime() : x);
  const match = (d, f, op, v) => {
    if (!d || !Object.prototype.hasOwnProperty.call(d, f)) return false;
    const a = val(d[f]), b = val(v);
    return op === '==' ? a === b : op === '>=' ? a >= b : op === '<=' ? a <= b : false;
  };
  function query(cp, filters, lim) {
    return {
      where: (f, op, v) => query(cp, filters.concat([[f, op, v]]), lim),
      orderBy: () => query(cp, filters, lim),
      limit: (n) => query(cp, filters, n),
      get: async () => {
        const depth = cp.split('/').length + 1;
        const rows = [...docs.keys()].filter((k) => k.startsWith(cp + '/') && k.split('/').length === depth
          && filters.every(([f, op, v]) => match(docs.get(k), f, op, v))).slice(0, lim || 1e9).map(snap);
        return { docs: rows, size: rows.length, empty: rows.length === 0, forEach: (fn) => rows.forEach(fn) };
      },
    };
  }
  function coll(cp) {
    const next = () => 'auto' + String(++auto).padStart(10, '0');
    return Object.assign(query(cp, [], null), {
      doc: (id) => mk(cp + '/' + (id || next())),
      add: async (v) => { const r = mk(cp + '/' + next()); await r.set(v); return r; },
    });
  }
  return { docs, doc: mk, collection: coll, runTransaction: async (fn) => fn({ get: (r) => r.get(), set: (r, v, o) => r.set(v, o), update: (r, v) => r.update(v) }) };
}

let DB = fakeDb();
const serverTimestamp = () => { const t = Date.now(); return { toMillis: () => t }; };
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'firebase-admin/firestore') return { getFirestore: () => DB, FieldValue: { serverTimestamp } };
  // R3-1 (2026-10-06): crmMcp re-checks every key's creator in Auth. Each
  // test identity is an enabled member carrying its own claims.
  if (request === 'firebase-admin/auth') return { getAuth: () => ({ getUser: async (uid) => ({ uid, disabled: false, customClaims: uid === 'ownerA' ? { companyId: 'coA', role: 'company_admin' } : {} }) }) };
  if (/upstash-ratelimit$/.test(request)) return { enforceRateLimit: async () => ({ count: 1 }) };
  return origLoad.apply(this, arguments);
};
const L = require(path.join(ROOT, 'functions', 'agent-mcp-logic.js'));
const M = require(path.join(ROOT, 'functions', 'agent-mcp.js'));
const Suppress = require(path.join(ROOT, 'functions', 'email-suppression.js'));
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

const NBD = '1phDvAVXHSg82wDLegAbQFq14Ci1';
const KEYS = {};
['marcus', 'tucker', 'dana', 'priya', 'cos', 'quinn', 'frank'].forEach((b) => { KEYS[b] = 'nbdk_' + b + '_key_' + '0'.repeat(30 - b.length); });
// Every phone / email seeded below — no tool answer may contain any of them.
const PHONES = ['5135550147', '5135550148', '5135550149', '5135550150'];
const EMAILS = ['maria@example.test', 'sam@example.test'];
const S0 = (p, v) => DB.docs.set(p, v);
function seed() {
  DB = fakeDb();
  const S = (p, v) => DB.docs.set(p, v);
  Object.keys(KEYS).forEach((b) => S('agent_keys/' + sha(KEYS[b]), { botId: b, botName: L.BOTS[b].name, companyId: NBD, active: true, prefix: KEYS[b].slice(0, 9), createdBy: NBD }));
  S('leads/ok1', { userId: NBD, companyId: NBD, firstName: 'Maria', lastName: 'Lopez', address: '1420 Oak St', phone: '(513) 555-0147', email: 'maria@example.test', tcpaConsent: true, stage: 'contacted' });
  S('leads/stop1', { userId: NBD, firstName: 'Stan', lastName: 'Stop', phone: '513-555-0148', email: 'sam@example.test', stage: 'contacted' });
  S('leads/stop2', { userId: NBD, firstName: 'Lena', lastName: 'Legacy', phone: '+1 513 555 0149', stage: 'contacted' });
  S('leads/declined', { userId: NBD, firstName: 'Dee', lastName: 'Clined', phone: '5135550150', tcpaConsent: false, stage: 'new' });
  S('leads/nophone', { userId: NBD, firstName: 'Nora', lastName: 'Nophone', stage: 'new' });
  S('leads/other', { userId: 'someoneElse', companyId: 'coX', firstName: 'Oscar', phone: '5135550199', email: 'o@example.test', stage: 'new' });
  S('sms_opt_outs/5135550148', { phone: '+15135550148' });   // canonical key
  S('sms_opt_outs/15135550149', { phone: '+15135550149' });  // pre-migration (legacy) key
  S('email_suppressions/' + Suppress.suppressionId(NBD, 'sam@example.test'), { source: 'link' });
}

const answers = [];
async function http(key, body) {
  const req = { method: 'POST', headers: { authorization: 'Bearer ' + key }, body, get(h) { return this.headers[String(h).toLowerCase()]; } };
  const res = { code: 200, body: null, set() { return this; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } };
  await M.crmMcp(req, res);
  answers.push(JSON.stringify(res.body));
  return res;
}
async function tool(bot, name, args) {
  const r = await http(KEYS[bot], { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args || {} } });
  const res = r.body && r.body.result;
  if (!res) return { error: r.body && r.body.error };
  let json = null; try { json = JSON.parse(res.content[0].text); } catch (_) {}
  return { isError: res.isError === true, text: res.content[0].text, json };
}
// A 'sent' here is the owner who already tapped through the Quinn warning
// (roadmap step 8; the gate itself is tests/quinn-gate-2026-11-25.test.js).
async function call(auth, data) {
  const d = data && data.action === 'sent' ? Object.assign({ confirmUnverified: true }, data) : data;
  try { return { r: await M.agentDraftAction.run({ auth, data: d || {}, rawRequest: {} }) }; } catch (e) { return { err: e }; }
}
const inbox = () => [...DB.docs.entries()].filter(([k]) => /^agent_inbox\//.test(k)).map(([k, v]) => Object.assign({ id: k.split('/')[1] }, v));
const rows = (c) => [...DB.docs.entries()].filter(([k]) => k.startsWith(c + '/')).map(([, v]) => v);

(async () => {
  console.log('A. rules');
  const names = (b) => L.toolsForBot(b).map((t) => t.name);
  ok('Marcus + Tucker get draft_text + draft_email, not the social draft', ['marcus', 'tucker'].every((b) => names(b).includes('draft_text') && names(b).includes('draft_email') && !names(b).includes('file_social_draft')));
  ok('Dana + Priya get file_social_draft, no customer drafts', ['dana', 'priya'].every((b) => names(b).includes('file_social_draft') && !names(b).includes('draft_text') && !names(b).includes('draft_email')));
  ok('only those four bots hold a draft tool', Object.keys(L.BOTS).filter((b) => L.DRAFT_TOOLS.some((t) => L.botAllows(b, t))).sort().join() === 'dana,marcus,priya,tucker');
  // + closes_this_week (2026-10-15, read-only): the What-closes-this-week radar for the morning brief / Command Deck.
  // + withdraw_item (2026-11-25, roadmap step 8): every filing bot may take back its own waiting item.
  ok('CoS keeps its exact list', L.BOTS.cos.tools.join() === 'crm_summary,schedule,overdue_followups,collected_revenue,lead_sources,inbox_pending,team_activity,closes_this_week,file_report,withdraw_item');
  ok('Frank gets post_job + file_reminder (and still no notes)', L.botAllows('frank', 'post_job') && L.botAllows('frank', 'file_reminder') && !L.botAllows('frank', 'file_note'));
  ok('company-made bots can never pick a draft tool', L.DRAFT_TOOLS.every((t) => L.CUSTOM_TOOLS.indexOf(t) === -1) && !!L.normalizeBotInput({ name: 'x', tools: ['draft_text'] }).error);
  ok('draft tools are marked as writes (not read-only)', L.DRAFT_TOOLS.every((t) => L.annotationsFor(t).readOnlyHint === false));
  ok('server version 1.3.0 (1.2.0 drafts; 1.3.0 list_leads paging)', L.SERVER_INFO.version === '1.3.0');
  const nbdNames = L.companyNames({}, true);
  let d = L.buildTextDraft({ body: 'Hi Maria, Joe with No Big Deal — still want the gutter quote?', reason: 'quiet 14 days' }, nbdNames);
  // Review R2-3-1 (2026-10-06): the honest line for a text sent from the owner's phone.
  ok('STOP line appended when missing', d.body === 'Hi Maria, Joe with No Big Deal — still want the gutter quote?\nReply STOP to opt out.');
  d = L.buildTextDraft({ body: 'No Big Deal here. Reply STOP to opt out.', reason: 'x' }, nbdNames);
  ok('STOP line not doubled when present', (d.body.match(/STOP/g) || []).length === 1);
  ok('company name is required', /company name/.test(L.buildTextDraft({ body: 'Hi Maria, want a quote?', reason: 'x' }, nbdNames).error || ''));
  ok('a company with no name set cannot text', !!L.buildTextDraft({ body: 'Hi', reason: 'x' }, L.companyNames({}, false)).error);
  // 480 = 'No Big Deal ' (12) + the x's + '\n' + the STOP line.
  const _fit = 480 - 12 - 1 - L.STOP_LINE.length;
  ok('480 characters including the STOP line', !!L.buildTextDraft({ body: 'No Big Deal ' + 'x'.repeat(_fit + 1), reason: 'x' }, nbdNames).error
    && !L.buildTextDraft({ body: 'No Big Deal ' + 'x'.repeat(_fit), reason: 'x' }, nbdNames).error);
  ok('reason is required', !!L.buildTextDraft({ body: 'No Big Deal hi' }, nbdNames).error);
  ok('email: from must be jd or info', !!L.buildEmailDraft({ subject: 's', body: 'b', reason: 'r', from: 'joe' }).error && L.buildEmailDraft({ subject: 's', body: 'b', reason: 'r', from: 'info' }).fromAddress === 'info@nobigdealwithjoedeal.com');
  ok('social: unknown platform / brand / non-https media refused', !!L.buildSocialDraft({ brand: 'nbd', platform: 'myspace', caption: 'c', reason: 'r' }).error
    && !!L.buildSocialDraft({ brand: 'acme', platform: 'facebook', caption: 'c', reason: 'r' }).error
    && !!L.buildSocialDraft({ brand: 'nbd', platform: 'facebook', caption: 'c', reason: 'r', media_url: 'javascript:alert(1)' }).error);
  ok('social: X caption over 280 refused', !!L.buildSocialDraft({ brand: 'pro', platform: 'x', caption: 'y'.repeat(281), reason: 'r' }).error);
  ok('the bot is told drafts are only sent by the owner', /only the owner sends it/.test(L.initializeResult({}, 'marcus').instructions) && !/DRAFT/.test(L.initializeResult({}, 'frank').instructions));

  console.log('B. the connection');
  seed();
  let t = await tool('marcus', 'draft_text', { lead_id: 'ok1', body: 'Hi Maria, Joe from No Big Deal. Still want that gutter quote?', reason: 'Estimate viewed 3x, quiet 9 days' });
  let items = inbox();
  ok('Marcus files a text draft', !t.isError && t.json && t.json.filed === true && t.json.kind === 'draft_text' && items.length === 1, t.text);
  ok('the inbox item holds the body + STOP line, the lead, the reason and consent — never the number', items[0] && items[0].kind === 'draft_text' && items[0].leadId === 'ok1' && /Reply STOP to opt out\.$/.test(items[0].text)
    && items[0].consentOnFile === true && items[0].status === 'pending' && !/555|0147/.test(JSON.stringify(items[0])));
  t = await tool('marcus', 'draft_text', { lead_id: 'stop1', body: 'No Big Deal here — quick question.', reason: 'x' });
  ok('Do-Not-Text (STOP register, canonical key) → refused', t.isError && /Do-Not-Text/.test(t.text));
  t = await tool('tucker', 'draft_text', { lead_id: 'stop2', body: 'No Big Deal here — quick question.', reason: 'x' });
  ok('Do-Not-Text under the pre-migration key → refused too', t.isError && /Do-Not-Text/.test(t.text));
  // #2215: isOptedOut REQUIRES opts.companyId and checks that company's own
  // Do Not Text list (sms_dnc/{companyId}__{key}). Without the bot's company
  // every draft was refused as "could not be checked".
  S0('leads/dnc1', { userId: NBD, companyId: NBD, firstName: 'Dana', lastName: 'Donot', phone: '513-555-0151', tcpaConsent: true, stage: 'contacted' });
  DB.docs.set('sms_dnc/' + NBD + '__5135550151', { companyId: NBD, key: '5135550151', source: 'manual' });
  t = await tool('marcus', 'draft_text', { lead_id: 'dnc1', body: 'No Big Deal here — quick question.', reason: 'x' });
  ok('the company\'s own Do Not Text list → refused, and says so', t.isError && /company's Do-Not-Text list/.test(t.text), t.text);
  DB.docs.delete('sms_dnc/' + NBD + '__5135550151');
  DB.docs.set('sms_dnc/coX__5135550151', { companyId: 'coX', key: '5135550151', source: 'manual' });
  t = await tool('marcus', 'draft_text', { lead_id: 'dnc1', body: 'No Big Deal here — quick question.', reason: 'x' });
  ok('ANOTHER company\'s Do Not Text entry does not block this company\'s draft', !t.isError && t.json && t.json.filed === true, t.text);
  DB.docs.delete('sms_dnc/coX__5135550151');
  inbox().filter((i) => i.leadId === 'dnc1').forEach((i) => DB.docs.delete('agent_inbox/' + i.id));
  t = await tool('marcus', 'draft_text', { lead_id: 'declined', body: 'No Big Deal here.', reason: 'x' });
  ok('declined texting on the form → refused', t.isError && /declined/.test(t.text));
  t = await tool('marcus', 'draft_text', { lead_id: 'nophone', body: 'No Big Deal here.', reason: 'x' });
  ok('no phone on file → refused', t.isError && /no textable phone/.test(t.text));
  t = await tool('marcus', 'draft_text', { lead_id: 'other', body: 'No Big Deal here.', reason: 'x' });
  ok('another company\'s customer → unknown lead', t.isError && /unknown lead_id/.test(t.text));
  t = await tool('marcus', 'draft_text', { lead_id: 'ok1', body: 'No Big Deal: we will handle your insurance claim for you.', reason: 'x' });
  ok('Kentucky claim wording refused in a draft', t.isError && /Kentucky/.test(t.text));
  t = await tool('tucker', 'draft_email', { lead_id: 'ok1', subject: 'Your gutter quote', body: 'Hi Maria — the quote is attached.', reason: 'follow-up', from: 'jd' });
  ok('Tucker files an email draft (From resolved, no address in the item)', !t.isError && inbox().some((i) => i.kind === 'draft_email' && i.fromAddress === 'jd@nobigdealwithjoedeal.com' && !/maria@/.test(JSON.stringify(i))), t.text);
  t = await tool('tucker', 'draft_email', { lead_id: 'stop1', subject: 'Hi', body: 'b', reason: 'r', from: 'jd' });
  ok('unsubscribed from email → refused', t.isError && /unsubscribed/.test(t.text));
  t = await tool('cos', 'draft_text', { lead_id: 'ok1', body: 'No Big Deal hi', reason: 'x' });
  ok('CoS cannot draft (not part of its role)', t.isError && /not part of your role/.test(t.text));
  t = await tool('dana', 'file_social_draft', { brand: 'nbd', platform: 'facebook', caption: 'Storm season tip: check your gutters.', reason: 'weekly tip', media_url: 'https://example.test/a.jpg', scheduled_for: '2026-10-10' });
  ok('Dana files a social draft into the inbox, nothing in social_posts', !t.isError && inbox().some((i) => i.kind === 'social_draft' && i.platform === 'facebook' && i.brand === 'nbd' && i.mediaUrl === 'https://example.test/a.jpg')
    && ![...DB.docs.keys()].some((k) => /social_posts/.test(k)), t.text);
  t = await tool('priya', 'file_social_draft', { brand: 'pro', platform: 'instagram', caption: 'New in the CRM.', reason: 'launch' });
  ok('Priya files one too; Instagram without media is flagged in the note', !t.isError && /needs a photo/.test(t.json.note));
  t = await tool('quinn', 'inbox_pending', {});
  ok('inbox_pending lists the drafts', !t.isError && t.json.items.filter((i) => /draft/.test(i.kind)).length === 4);
  await tool('marcus', 'lead_detail', { lead_id: 'ok1' });
  await http(KEYS.marcus, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const all = answers.join('\n');
  ok('no MCP answer carries any customer phone number', !PHONES.some((p) => all.replace(/\D/g, '').indexOf(p) !== -1) && !/\(513\)|513-555|\+1 513/.test(all), answers.length + ' answers');
  ok('no MCP answer carries any customer email address', !EMAILS.some((e) => all.indexOf(e) !== -1));

  console.log('C. the owner sends it (agentDraftAction)');
  const jo = { uid: NBD, token: { role: 'admin' } };
  const txt = inbox().find((i) => i.kind === 'draft_text');
  const em = inbox().find((i) => i.kind === 'draft_email');
  let r = await call(jo, { action: 'check', ids: [txt.id, em.id] });
  ok('check: ok, with the recipient for the owner only', r.r && r.r.results[txt.id].ok === true && r.r.results[txt.id].to === '+15135550147' && r.r.results[em.id].to === 'maria@example.test' && r.r.results[txt.id].name === 'Maria Lopez', JSON.stringify(r.r || r.err && r.err.message));
  DB.docs.set('sms_opt_outs/5135550147', { phone: '+15135550147' });
  r = await call(jo, { action: 'check', ids: [txt.id] });
  ok('check re-reads the Do-Not-Text list now (a STOP since filing blocks the send)', r.r && r.r.results[txt.id].ok === false && r.r.results[txt.id].code === 'opted_out' && /replied STOP/.test(r.r.results[txt.id].reason) && !r.r.results[txt.id].to);
  DB.docs.delete('sms_opt_outs/5135550147');
  DB.docs.set('sms_dnc/' + NBD + '__5135550147', { companyId: NBD, key: '5135550147', source: 'manual' });
  r = await call(jo, { action: 'check', ids: [txt.id] });
  ok('check also re-reads the company Do Not Text list (added since filing → blocked, no number)', r.r && r.r.results[txt.id].ok === false && r.r.results[txt.id].code === 'dnc' && /company's Do Not Text list/.test(r.r.results[txt.id].reason) && !r.r.results[txt.id].to, JSON.stringify(r.r || r.err && r.err.message));
  DB.docs.delete('sms_dnc/' + NBD + '__5135550147');
  for (const [who, label] of [[{ uid: 'v1', token: { companyId: NBD, role: 'viewer' } }, 'viewer'], [{ uid: 'rep1', token: { companyId: NBD, role: 'sales_rep' } }, 'sales rep']]) {
    r = await call(who, { action: 'check', ids: [txt.id] });
    ok('a ' + label + ' is refused', !!r.err && /owner or an admin/.test(r.err.message));
  }
  r = await call({ uid: 'ownerX', token: { companyId: 'coX', role: 'company_admin' } }, { action: 'sent', id: txt.id, body: 'x' });
  ok('another company cannot touch the draft', !!r.err && /No such draft/.test(r.err.message));
  r = await call(jo, { action: 'sent', id: txt.id, body: 'Hi Maria, Joe from No Big Deal — Thursday works?\nReply STOP to opt out.' });
  const sms = rows('sms_log');
  ok('sent → one sms_log row with leadId + uid + date (comm-log contract)', r.r && r.r.ok === true && sms.length === 1 && sms[0].leadId === 'ok1' && sms[0].uid === NBD && !!sms[0].date && sms[0].companyId === NBD && sms[0].status === 'sent_by_owner' && /Thursday works/.test(sms[0].body), JSON.stringify(sms));
  ok('…a note on the customer\'s card', rows('notes').some((n) => n.leadId === 'ok1' && n.userId === NBD && /Texted from my phone/.test(n.text) && /drafted by Marcus/.test(n.text)));
  const after = DB.docs.get('agent_inbox/' + txt.id);
  ok('…and the item is sent_by_owner with the edited text', after.status === 'sent_by_owner' && after.decidedBy === NBD && /Thursday works/.test(after.text) && /^sms_log:/.test(after.result || ''));
  r = await call(jo, { action: 'sent', id: txt.id, body: 'Hi Maria, Joe from No Big Deal — Thursday works?\nReply STOP to opt out.' });
  ok('a double tap logs once', r.r && r.r.already === true && rows('sms_log').length === 1);
  r = await call(jo, { action: 'sent', id: em.id, subject: 'Your gutter quote', body: 'Hi Maria' });
  const eml = rows('email_log');
  ok('email: email_log row with leadId + uid + date + subject', r.r && eml.length === 1 && eml[0].leadId === 'ok1' && eml[0].uid === NBD && !!eml[0].date && eml[0].subject === 'Your gutter quote' && eml[0].from === 'jd@nobigdealwithjoedeal.com');
  // Audit 2026-11-22: an owner-sent review ask must stamp the lead, so every
  // other "already asked?" check (post_job, the automatic ask, the nudge) sees it.
  let lead1 = DB.docs.get('leads/ok1');
  ok('a non-review draft sent by the owner does NOT stamp reviewRequested / reviewRequestedAt', lead1.reviewRequested !== true && !lead1.reviewRequestedAt && !lead1.reviewRequestSource, JSON.stringify(lead1));
  t = await tool('tucker', 'draft_email', { lead_id: 'ok1', subject: 'Would you leave No Big Deal Home Solutions a quick Google review?', body: 'Hi Maria,\n\nWould you take a minute to leave us a Google review?\n\nhttps://g.page/r/CXzIjLwvtRPdEBM/review\n\nThank you', reason: 'review sprint', from: 'jd' });
  const revEm = inbox().find((i) => i.kind === 'draft_email' && i.status === 'pending' && /Google review/.test(i.title));
  ok('a review-ask email draft (Google review link) is filed marked purpose review_ask', !t.isError && revEm && revEm.purpose === 'review_ask', t.text + ' ' + JSON.stringify(revEm));
  r = await call(jo, { action: 'sent', id: revEm.id, subject: revEm.title, body: revEm.text });
  lead1 = DB.docs.get('leads/ok1');
  ok('sending a review-ask draft stamps reviewRequested + reviewRequestedAt (+ source) on the lead', r.r && r.r.ok === true && lead1.reviewRequested === true && !!lead1.reviewRequestedAt && lead1.reviewRequestSource === 'agent-draft-email', JSON.stringify(lead1));
  const pj = L.postJob([Object.assign({ id: 'ok1' }, lead1, { stage: 'final_payment', completedAt: Date.now() - 86400000 })], [], Date.now(), {}, 'America/New_York');
  ok('…and post_job now reads the customer as asked', pj.length === 1 && pj[0].review_requested === true, JSON.stringify(pj));
  S0('leads/rev2', { userId: NBD, companyId: NBD, firstName: 'Rita', lastName: 'Review', phone: '(513) 555-0152', tcpaConsent: true, stage: 'closed' });
  t = await tool('marcus', 'draft_text', { lead_id: 'rev2', body: 'Hi Rita, Joe with No Big Deal. Would you leave us a review? https://example.test/r', reason: 'review sprint', purpose: 'review_ask' });
  const revTx = inbox().find((i) => i.leadId === 'rev2');
  ok('purpose "review_ask" marks a text draft even without a Google link', !t.isError && revTx && revTx.purpose === 'review_ask', t.text);
  r = await call(jo, { action: 'sent', id: revTx.id, body: revTx.text });
  const lead2 = DB.docs.get('leads/rev2');
  ok('sending it stamps the lead with the text source', r.r && r.r.ok === true && lead2.reviewRequested === true && !!lead2.reviewRequestedAt && lead2.reviewRequestSource === 'agent-draft-text', JSON.stringify(lead2));
  S0('leads/plain3', { userId: NBD, companyId: NBD, firstName: 'Paul', lastName: 'Plain', phone: '(513) 555-0153', tcpaConsent: true, stage: 'contacted' });
  t = await tool('marcus', 'draft_text', { lead_id: 'plain3', body: 'Hi Paul, Joe with No Big Deal. I reviewed your estimate; Thursday still good?', reason: 'follow-up' });
  const plain = inbox().find((i) => i.leadId === 'plain3');
  r = await call(jo, { action: 'sent', id: plain.id, body: plain.text });
  const lead3 = DB.docs.get('leads/plain3');
  ok('a follow-up that merely says "reviewed" is not a review ask: no purpose, no stamp', !plain.purpose && r.r && r.r.ok === true && lead3.reviewRequested !== true && !lead3.reviewRequestedAt, JSON.stringify(lead3));
  // A customer already asked gets no second review draft (the prompt's
  // review_requested check is advisory; the server refuses).
  const REV_EMAIL = { subject: 'A quick Google review?', body: 'Hi Maria,\n\nWould you leave us a Google review?\n\nhttps://g.page/r/CXzIjLwvtRPdEBM/review', reason: 'post job', from: 'jd' };
  let nInbox = inbox().length;
  t = await tool('tucker', 'draft_email', Object.assign({ lead_id: 'ok1', purpose: 'review_ask' }, REV_EMAIL));
  ok('a second review-ask draft for a customer already asked is refused, nothing filed', t.isError === true && /already asked/i.test(t.text) && inbox().length === nInbox, t.text);
  S0('leads/auto5', { userId: NBD, companyId: NBD, firstName: 'Ann', lastName: 'Auto', phone: '(513) 555-0155', tcpaConsent: true, stage: 'closed', reviewAutoAsk: { jobKey: '_lead', status: 'sent' } });
  t = await tool('marcus', 'draft_text', { lead_id: 'auto5', body: 'Hi Ann, Joe with No Big Deal. Would you leave us a Google review? https://g.page/r/CXzIjLwvtRPdEBM/review', reason: 'sprint', purpose: 'review_ask' });
  ok('…also when the automatic ask already went (reviewAutoAsk)', t.isError === true && /already asked/i.test(t.text), t.text);
  // Two bots drafting one ask each: the second is refused while the first waits.
  S0('leads/two6', { userId: NBD, companyId: NBD, firstName: 'Tom', lastName: 'Two', phone: '(513) 555-0156', email: 'tom@example.test', tcpaConsent: true, stage: 'closed' });
  t = await tool('marcus', 'draft_text', { lead_id: 'two6', body: 'Hi Tom, Joe with No Big Deal. Would you leave us a Google review? https://g.page/r/CXzIjLwvtRPdEBM/review', reason: 'sprint', purpose: 'review_ask' });
  ok('the first review-ask draft for a customer files', !t.isError, t.text);
  nInbox = inbox().length;
  t = await tool('tucker', 'draft_email', Object.assign({ lead_id: 'two6', purpose: 'review_ask' }, REV_EMAIL));
  ok('a second review-ask draft while the first is waiting is refused', t.isError === true && /already/i.test(t.text) && inbox().length === nInbox, t.text);
  t = await tool('marcus', 'draft_text', { lead_id: 'two6', body: 'Hi Tom, Joe with No Big Deal. Gutters Thursday?', reason: 'follow-up', purpose: 'review' });
  ok('a purpose other than "review_ask" is refused, not silently dropped', t.isError === true && /purpose/.test(t.text), t.text);
  // The send re-reads the lead: asked since the draft was filed → refused,
  // the first ask's time and source kept, the item still pending.
  const two = inbox().find((i) => i.leadId === 'two6' && i.status === 'pending');
  S0('leads/two6', Object.assign({}, DB.docs.get('leads/two6'), { reviewRequested: true, reviewRequestedAt: 111, reviewRequestSource: 'review-ask-auto-text' }));
  const smsBefore = rows('sms_log').length;
  r = await call(jo, { action: 'sent', id: two.id, body: two.text });
  const lead6 = DB.docs.get('leads/two6');
  ok('sending a review ask to a customer asked since → refused, nothing logged', !!r.err && r.err.code === 'failed-precondition' && /already asked/i.test(r.err.message) && rows('sms_log').length === smsBefore && DB.docs.get('agent_inbox/' + two.id).status === 'pending', r.err ? r.err.code + ' ' + r.err.message : JSON.stringify(r.r));
  ok('…and the earlier ask\'s time and source are kept', lead6.reviewRequestedAt === 111 && lead6.reviewRequestSource === 'review-ask-auto-text', JSON.stringify(lead6));
  // An ordinary draft the owner edits to add the review link counts as an ask.
  S0('leads/edit7', { userId: NBD, companyId: NBD, firstName: 'Eve', lastName: 'Edit', phone: '(513) 555-0157', tcpaConsent: true, stage: 'closed' });
  t = await tool('marcus', 'draft_text', { lead_id: 'edit7', body: 'Hi Eve, Joe with No Big Deal. Thanks again!', reason: 'thank you' });
  const ed = inbox().find((i) => i.leadId === 'edit7');
  r = await call(jo, { action: 'sent', id: ed.id, body: 'Hi Eve, Joe with No Big Deal. Thanks again! Would you leave us a Google review? https://g.page/r/CXzIjLwvtRPdEBM/review\nReply STOP to opt out.' });
  const lead7 = DB.docs.get('leads/edit7');
  ok('a plain draft edited to carry the Google review link stamps the lead', !ed.purpose && r.r && r.r.ok === true && lead7.reviewRequested === true && lead7.reviewRequestSource === 'agent-draft-text', JSON.stringify(r.err ? r.err.message : lead7));
  // The lead hard-deleted between the check and the claim: a clean not-found,
  // and the draft stays pending.
  S0('leads/gone8', { userId: NBD, companyId: NBD, firstName: 'Gus', lastName: 'Gone', phone: '(513) 555-0158', tcpaConsent: true, stage: 'closed' });
  t = await tool('marcus', 'draft_text', { lead_id: 'gone8', body: 'Hi Gus, Joe with No Big Deal. Would you leave us a Google review? https://g.page/r/CXzIjLwvtRPdEBM/review', reason: 'sprint', purpose: 'review_ask' });
  const gone = inbox().find((i) => i.leadId === 'gone8');
  const realTx = DB.runTransaction;
  DB.runTransaction = async (fn) => { DB.docs.delete('leads/gone8'); return realTx(fn); };
  r = await call(jo, { action: 'sent', id: gone.id, body: gone.text });
  DB.runTransaction = realTx;
  ok('a lead deleted mid-send → not-found HttpsError, draft still pending', !!r.err && r.err.code === 'not-found' && DB.docs.get('agent_inbox/' + gone.id).status === 'pending', r.err ? r.err.code + ' ' + r.err.message : JSON.stringify(r.r));
  const soc = inbox().find((i) => i.kind === 'social_draft');
  r = await call(jo, { action: 'sent', id: soc.id, body: 'x' });
  ok('a social draft cannot be "sent" through it', !!r.err);
  const team = L.teamActivity([], [{ botId: 'marcus', status: 'sent_by_owner', createdAt: Date.now() }], Date.now(), 7);
  ok('team_activity counts a sent draft as approved', team.bots.find((b) => b.bot_id === 'marcus').approved === 1);

  console.log('D. the Agent inbox');
  const win = { location: { search: '', pathname: '/pro/dashboard.html', hash: '' }, history: { replaceState() {} }, _leads: [{ id: 'ok1', firstName: 'Maria', lastName: 'Lopez' }] };
  win.window = win;
  const ctx = vm.createContext({ window: win, navigator: { userAgent: '' }, document: { readyState: 'complete', addEventListener() {} }, console, setTimeout, JSON, Math, String, encodeURIComponent });
  vm.runInContext(read('docs/pro/js/agent-inbox.js'), ctx);
  const A = win.NBDAgentInbox;
  const evil = '<img src=x onerror=alert(1)>';
  const tItem = { id: 'd1', kind: 'draft_text', leadId: 'ok1', bot: 'Marcus ' + evil, text: 'Hi & ' + evil, reason: 'why ' + evil, consentOnFile: false };
  const htmlOk = A.draftRowHtml(tItem, { ok: true, to: '+15135550147', name: 'Maria ' + evil }, true);
  ok('text draft: customer name, editable textarea, "Text from my phone" sms: link, Toss', /Text from my phone/.test(htmlOk) && /<textarea[^>]+id="aiText-d1"/.test(htmlOk) && /href="sms:\+15135550147&amp;body=Hi%20%26%20/.test(htmlOk) && /data-ai-act="dismiss"/.test(htmlOk) && /Maria &lt;img/.test(htmlOk));
  ok('every bot-provided string is escaped (no raw tag, no inline handler)', !/<img/.test(htmlOk) && !/\son\w+=/.test(htmlOk.replace(/&lt;[^]*?&gt;/g, '')));
  ok('iOS link uses "&body=", Android "?body="', A.smsHref('+15135550147', 'a b', true) === 'sms:+15135550147&body=a%20b' && A.smsHref('+15135550147', 'a b', false) === 'sms:+15135550147?body=a%20b');
  ok('iPhone / iPad detection (incl. iPadOS as a touch Mac)', A.isIOS('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)') && A.isIOS('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', 5) && !A.isIOS('Mozilla/5.0 (Linux; Android 15)'));
  const blocked = A.draftRowHtml(tItem, { ok: false, reason: 'This customer is on the Do-Not-Text list.' }, true);
  ok('a failed check shows why and has no sms: link', /Do-Not-Text/.test(blocked) && !/href="sms:/.test(blocked) && /disabled/.test(blocked));
  const eHtml = A.draftRowHtml({ id: 'e1', kind: 'draft_email', leadId: 'ok1', bot: 'Tucker', title: 'Quote ' + evil, text: 'Body', fromAddress: 'jd@nobigdealwithjoedeal.com' }, { ok: true, to: 'maria@example.test', name: 'Maria' }, false);
  ok('email draft: subject + body editable, Copy, Open in Mail (mailto:), Mark sent, Toss', /id="aiSubj-e1"/.test(eHtml) && /data-ai-act="copy"/.test(eHtml) && /href="mailto:maria@example.test\?subject=Quote%20%3Cimg/.test(eHtml) && /data-ai-act="mailsent"/.test(eHtml) && /data-ai-act="dismiss"/.test(eHtml) && !/<img/.test(eHtml));
  const sItem = { id: 's1', kind: 'social_draft', bot: 'Dana', title: 'No Big Deal · Facebook', text: 'Tip ' + evil, platform: 'facebook', brand: 'nbd', mediaUrl: 'javascript:alert(1)', scheduledFor: '2026-10-10' };
  const sHtml = A.draftRowHtml(sItem, null, false);
  ok('social draft: Send to Social Studio + Toss; a non-https media link is not rendered', /Send to Social Studio/.test(sHtml) && /data-ai-act="social"/.test(sHtml) && !/javascript:/.test(sHtml) && !/<img/.test(sHtml));
  const post = A.socialPostFor(sItem, NBD, NBD, 'Edited tip');
  const FORBIDDEN = ['approvedAt', 'approvedBy', 'publish', 'platformPostId', 'sourceLeadId', 'reelId', 'video', 'aiGenerated'];
  ok('the Social Studio draft is status draft, owned by the owner, with no server-only key (the create rule)', post.data.status === 'draft' && post.data.companyId === NBD && post.data.createdBy === NBD && post.data.caption === 'Edited tip' && !FORBIDDEN.some((k) => k in post.data));
  ok('drafts are not in "Add all" and the deck skips them', A.bulkIds([{ id: 'a', kind: 'draft_text' }, { id: 'b', kind: 'note' }], false).join() === 'b' && /filter\(\(it\) => !isDraft\(it\)\)/.test(read('docs/pro/js/agent-inbox.js')));
  const src = read('docs/pro/js/agent-inbox.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // Review R2-3-1: the sms: link is held (preventDefault) until the server's
  // 'sent' check answers ok, then opened — still the owner's own Messages app.
  ok('the inbox never sends: no SMS / email API; the sms: link opens only after the server says ok', !/sendSMS|sendEmail|NBDComms|sendQueued/.test(src)
    && /if \(act === 'text'\) ev\.preventDefault\(\);[\s\S]{0,200}if \(await markSent\(id\)\) \{[\s\S]{0,80}window\.location\.assign\(href\)/.test(src));
  ok('rowHtml routes the three kinds to the draft renderer', /if \(isDraft\(it\)\) return draftRowHtml/.test(src));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
