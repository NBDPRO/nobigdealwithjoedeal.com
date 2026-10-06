/**
 * tests/review-r2-money-texting-2026-10-06.test.js
 *
 * Review round 2 (Jo's phased review, approved 2026-10-05), 2026-10-06:
 *   area 2 — "same number everywhere" (one job's money on the estimate, the
 *            contract, the deal room, the portal, the invoice, Stripe and the
 *            dashboards);
 *   area 3 — texting compliance (STOP, quiet hours, consent, preview, every
 *            send path).
 *
 * Review rule (Jo): find, verify, PIN and report — do NOT fix. Every bug here
 * is real on origin/main b9bc53e2 and is pinned as `KNOWN BUG R2-<area>-<n>`:
 * the assertion holds TODAY's wrong behaviour exactly, so the suite is green,
 * and the PR that fixes a bug must flip its pin (to `FIXED (was KNOWN BUG …)`
 * with the correct behaviour) — with Jo's OK. The report with evidence,
 * effect and suggested fix: nbd-content/review-r2-2026-10-06.md.
 *
 * Texting gaps already fixed in the open PRs #2215 / #2222 / #2223 (STOP
 * phrases, Do Not Text list, quiet hours on every path, door-knock and storm
 * consent, master switch) are NOT pinned here — pinning them would break
 * those PRs.
 *
 * Behavioural pins (the real module runs on a fixture) wherever the code can
 * run in Node; source pins otherwise. Every source pin strips comments first
 * (line-oriented stripper, pinned in section S), is brace-scoped to the one
 * block it is about, and asserts its anchor was FOUND, so a moved or renamed
 * block fails loudly instead of passing on an empty string.
 *
 * Pure Node, no functions/ install needed:
 *   node tests/review-r2-money-texting-2026-10-06.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const rd = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(msg, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; fails.push(msg); console.log('  ✗ ' + msg + (detail ? '\n      ' + detail : '')); }
}

// ── Source helpers ──────────────────────────────────────────────────────
// Line-oriented comment stripper (rule-grep-guards-must-strip-comments):
// whole-line //, trailing // (not ://), and /* */ blocks. It never touches
// string literals, so it cannot swallow code; over-stripping can only make an
// anchor go missing, which fails loudly below.
function stripComments(src) {
  const out = [];
  let inBlock = false;
  for (const line of String(src).split(/\r?\n/)) {
    let s = '';
    let i = 0;
    while (i < line.length) {
      if (inBlock) {
        const e = line.indexOf('*/', i);
        if (e === -1) { i = line.length; break; }
        i = e + 2; inBlock = false; continue;
      }
      // Whichever comes first on the line wins: a // (not the one in ://)
      // ends the line; a /* opens a block. "// a/** b" is a line comment.
      let sl = line.indexOf('//', i);
      while (sl > 0 && line[sl - 1] === ':') sl = line.indexOf('//', sl + 2);
      const bl = line.indexOf('/*', i);
      if (sl !== -1 && (bl === -1 || sl < bl)) { s += line.slice(i, sl); i = line.length; break; }
      if (bl !== -1) { s += line.slice(i, bl); i = bl + 2; inBlock = true; continue; }
      s += line.slice(i); i = line.length;
    }
    out.push(s);
  }
  return out.join('\n');
}
// The { … } block that opens at the first '{' at/after `from`. null if unbalanced.
function braceBlock(src, from) {
  const open = src.indexOf('{', from);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return null;
}
// The block opened by the first `needle` (after `after`, when given).
function blockAt(src, needle, after) {
  const base = after ? src.indexOf(after) : 0;
  if (base === -1) return null;
  const at = src.indexOf(needle, base);
  return at === -1 ? null : braceBlock(src, at + needle.length - 1);
}

const F = (rel) => require(path.join(FN, rel));

(async () => {
  // ════════════════════════════════════════════════════════════════════
  // AREA 2 — same number everywhere
  // ════════════════════════════════════════════════════════════════════
  console.log('\nArea 2 — same number everywhere');

  // R2-2-1 ─ the homeowner's accepted tier vs the estimate
  {
    const DAT = F('deal-accepted-tier.js');
    const DDL = F('deposit-draft-logic.js');
    const addr = '1 Main St, Cincinnati, OH 45202';
    // A V2 per-SQ estimate. V2 ALWAYS saves a tier (state.tier 'better'), so it
    // is never "tier-less" and #2183's recompute does not apply to it.
    const est = { userId: 'u', leadId: 'L', priceMode: 'per-sq', prices: { good: 10500, better: 12000, best: 15000 },
      tier: 'better', selectedTier: 'better', grandTotal: 12000, subtotal: 11162.79, tax: 837.21, taxRate: 0.075,
      mode: 'cash', jobId: 'J1', addr };
    const lead = { userId: 'u', primaryEstimateId: 'E', jobValue: 12000, address: addr, state: 'OH', activeJobId: 'J1' };
    const plan = DAT.planAcceptedTier({ lead, estimate: est, estimateId: 'E', leadId: 'L', ownerUid: 'u', tier: 'good', price: 10500, dealId: 'D', now: 1 });
    const dd = DDL.decideDepositDraft({ leadId: 'L', event: 'deal_accepted', lead, est, estimateId: 'E',
      deal: { estimateId: 'E', acceptedTier: 'good', acceptedPrice: 10500 }, existingInvoices: [] });
    const paid = Object.assign({ id: dd.invoiceId }, dd.invoice, { status: 'paid', amountPaid: 10500, balanceDue: 0, createdAt: 1 });
    const fd = DDL.decideFinalDraft({ leadId: 'L', lead, est, estimateId: 'E', invoices: [paid] });
    ok('KNOWN BUG R2-2-1 (reported 2026-10-06): homeowner accepts Standard $10,500 on a V2 per-SQ estimate quoted at Preferred $12,000 — '
      + 'the estimate/jobValue/portal stay $12,000 (only recorded, "recorded-differs"), the signing-day draft bills $10,500, and after it is paid '
      + 'the install-day final draft bills another $1,500 (total billed $12,000 for a $10,500 acceptance). Expected one price on every surface',
      plan.reason === 'recorded-differs' && plan.estimate && plan.estimate.grandTotal === undefined && plan.lead.jobValue === undefined
        && dd.action === 'create' && dd.invoice.total === 10500
        && fd.action === 'create' && fd.invoice.total === 1500,
      JSON.stringify({ reason: plan.reason, draft: dd.invoice && dd.invoice.total, final: fd.invoice && fd.invoice.total }));
  }

  // R2-2-2 ─ contract + estimate view lines don't foot to the price
  {
    const CER = F('customer-estimate-rows.js');
    const sum = (rows) => Math.round(rows.reduce((s, r) => s + r.total, 0) * 100) / 100;
    const taxed = { rows: [{ desc: 'Tear off + install', qty: '20 SQ', retailTotal: 8000, total: 8000 }, { desc: 'Ridge vent', qty: '40 LF', retailTotal: 800, total: 800 }],
      materialMarkupPct: 0.25, overhead: 880, profit: 880, overheadPct: 0.1, profitPct: 0.1, subtotal: 10560, tax: 739.2, taxRate: 0.07, grandTotal: 11300 };
    const minJob = { rows: [{ desc: 'Pipe boot repair', qty: '1 EA', retailTotal: 555, total: 555 }], materialMarkupPct: 0.3,
      subtotal: 555, tax: 41.63, taxRate: 0.075, grandTotal: 2500, minJobApplied: true };
    const r1 = CER.buildDisplayRows(taxed), r2 = CER.buildDisplayRows(minJob);
    const noAdj = (rows) => !rows.some((r) => /tax|round|minimum/i.test(r.desc));
    ok('KNOWN BUG R2-2-2 (reported 2026-10-06): buildDisplayRows (the e-sign contract, the estimate view link, getEstimateForView) has no tax row and no Rounding / Minimum job row — '
      + 'a taxed $11,300 job lists $10,560 of lines; a $2,500 minimum job lists $555 under "Contract price $2,500". Expected lines that foot to the price, like the invoice (#2200) and the estimate PDF',
      sum(r1) === 10560 && sum(r2) === 555 && noAdj(r1) && noAdj(r2),
      JSON.stringify({ taxed: sum(r1), minJob: sum(r2) }));
  }

  // R2-2-3 ─ editing an estimate never refreshes lead.jobValue
  {
    const src = stripComments(rd('docs/pro/js/dashboard-bootstrap.module.js'));
    const fn = blockAt(src, 'window._saveEstimate = async (data) => {');
    const edit = fn && blockAt(fn, 'if (editId) {');
    const create = fn && fn.slice(fn.indexOf(edit || '\u0000') + (edit || '').length);
    ok('R2-2-3 anchor: window._saveEstimate and its edit branch are found, the edit branch still updates the estimate, and the create branch still stamps jobValue',
      !!edit && /updateDoc\(\s*doc\(\s*db\s*,\s*'estimates'/.test(edit) && /jobValue/.test(create || ''));
    ok('KNOWN BUG R2-2-3 (reported 2026-10-06): re-saving an existing estimate (V2 reopen / re-send) updates the estimate only — lead.jobValue keeps the OLD total, '
      + 'so the kanban, Home KPIs, Numbers, crm_summary and the contract prefill (R2-2-4) show it. Expected: when the edited estimate is the lead\'s primaryEstimateId, jobValue follows the new total',
      !!edit && !/jobValue|primaryEstimateId/.test(edit));
  }

  // R2-2-4 ─ the contract / proposal price prefills lead.jobValue first
  {
    const DG = path.join(ROOT, 'docs/pro/js');
    const win = { _brand: () => ({ legalName: 'X', colors: {}, contact: {} }) };
    win.window = win;
    const noop = () => ({ style: {}, appendChild() {}, setAttribute() {}, addEventListener() {}, classList: { add() {}, remove() {} } });
    const sandbox = { window: win, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, Date, Math, JSON,
      document: { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; }, createElement: noop, head: noop(), body: noop() } };
    for (const f of ['estimate-config.js', 'document-generator.js', 'document-generator-templates.js', 'doc-preflight.js']) {
      vm.runInNewContext(fs.readFileSync(path.join(DG, f), 'utf8'), sandbox, { filename: f });
    }
    const resolve = win.DocPreflight && win.DocPreflight._resolveFieldValue;
    ok('R2-2-4 anchor: DocPreflight._resolveFieldValue is exposed', typeof resolve === 'function');
    const field = { key: 'totalPrice', source: 'computed.jobValue' };
    const v = resolve ? resolve(field, { lead: { jobValue: 14500 }, estimate: { grandTotal: 16200 } }) : null;
    ok('KNOWN BUG R2-2-4 (reported 2026-10-06): the pre-flight "Total Price" / "Contract Price" prefills lead.jobValue ($14,500) over the selected estimate\'s own grandTotal ($16,200). '
      + 'Expected the estimate being documented to win when one is selected',
      Number(v) === 14500, 'got ' + v);
  }

  // R2-2-5 ─ the deal room's deposit ignores the claim ACV and a rep override
  {
    const DR = F('deposit-rule.js');
    const addr = '1 Main St, Cincinnati, OH 45202';
    const ins = { grandTotal: 12000, mode: 'insurance', claim: { deductible: 1000, acv: 8000 }, addr };
    const estDep = DR.fromEstimate(ins, { lead: { address: addr, state: 'OH' } }).depositCents / 100;
    const roomDep = DR.compute({ total: 12000, mode: 'insurance', deductible: 1000, address: addr, lead: { address: addr, state: 'OH' } }).depositCents / 100;
    ok('R2-2-5 context: for one Ohio insurance job the estimate/invoice rule asks $8,000 at signing and the deal room\'s call shape asks $1,000',
      estDep === 8000 && roomDep === 1000, JSON.stringify({ estDep, roomDep }));
    const src = stripComments(rd('docs/pro/js/close-board.js'));
    const at = src.indexOf('const _tierPlan = (price) =>');
    const end = at === -1 ? -1 : src.indexOf('const depositLine', at);
    const tp = at === -1 || end === -1 ? '' : src.slice(at, end);
    ok('R2-2-5 anchor: close-board.js _tierPlan is found and calls the deposit rule', /_depRule\.(compute|fromEstimate)\(/.test(tp));
    ok('KNOWN BUG R2-2-5 (reported 2026-10-06): the deal room prices each tier\'s deposit with NBDDepositRule.compute({ total, mode, deductible, address, lead }) — no claim ACV, no stored override / depositPctOverride — '
      + 'so it shows "$1,000 due at signing" where the estimate, contract and invoice say $8,000 (and $6,000 vs a 30% override\'s $3,600). Expected fromEstimate with the estimate\'s inputs',
      /_depRule\.compute\(/.test(tp) && !/acv|override|fromEstimate/i.test(tp));
  }

  // R2-2-6 ─ "Deposit due" is text only: every online pay path charges the whole job
  {
    const DDL = F('deposit-draft-logic.js');
    const addr = '1 Main St, Cincinnati, OH 45202';
    const est = { userId: 'u', leadId: 'L', grandTotal: 12000, subtotal: 12000, tax: 0, mode: 'cash', jobId: 'J1', addr,
      rows: [{ desc: 'Roof', qty: '1', retailTotal: 12000, total: 12000 }] };
    const lead = { userId: 'u', primaryEstimateId: 'E', address: addr, state: 'OH', activeJobId: 'J1' };
    const dd = DDL.decideDepositDraft({ leadId: 'L', event: 'contract_signed', lead, est, estimateId: 'E', existingInvoices: [] });
    const inv = dd.invoice || {};
    const src = stripComments(rd('functions/stripe.js'));
    const line = (src.match(/const balanceDueCents\s*=\s*[^;]+;/) || [''])[0];
    ok('R2-2-6 anchor: stripe.js still computes the pay-link amount as balanceDueCents', !!line);
    ok('KNOWN BUG R2-2-6 (reported 2026-10-06): the signing-day invoice for a $12,000 cash job carries depositAmount $6,000 but balanceDue $12,000, and the Stripe pay link charges '
      + 'total − amountPaid (no deposit term) — the homeowner reads "Deposit due $6,000" and Pay Now charges $12,000. Expected a way to pay just the deposit online (or no pay link until it exists)',
      dd.action === 'create' && inv.total === 12000 && inv.depositAmount === 6000 && inv.balanceDue === 12000
        && /expectedTotalCents\s*-\s*amountPaidCents/.test(line) && !/deposit/i.test(line),
      JSON.stringify({ action: dd.action, total: inv.total, dep: inv.depositAmount, bal: inv.balanceDue, line }));
  }

  // R2-2-7 ─ a customer's second job counts on some surfaces and not others
  {
    const pipe = stripComments(rd('docs/pro/js/crm-pipeline.js'));
    const render = blockAt(pipe, 'function renderLeads(leads, filtered)');
    const kpi = stripComments(rd('docs/pro/js/analytics-kpi.js'));
    const compute = blockAt(kpi, 'function computeKPIs()');
    ok('R2-2-7 anchor: renderLeads and computeKPIs are found; the kanban header still sums parseFloat(l.jobValue)',
      !!render && !!compute && /parseFloat\(\s*l\.jobValue/.test(render));
    ok('KNOWN BUG R2-2-7 (reported 2026-10-06; latent — 0 multi-job customers in prod today): the Home KPI tiles count every open job (computeKPIs → NBDJobs.recordsFor via _jobRecs) '
      + 'but the kanban header Pipeline / Closed totals (renderLeads) sum leads only — a $10k job + a second $8k job reads $18k on Home and $10k on the board',
      !!compute && /_jobRecs\(/.test(compute) && !!render && !/recordsFor|_jobRecs/.test(render));
  }

  // ════════════════════════════════════════════════════════════════════
  // AREA 3 — texting compliance
  // ════════════════════════════════════════════════════════════════════
  console.log('\nArea 3 — texting compliance');

  // R2-3-1 ─ bot draft texts (#2228)
  {
    const L = F('agent-mcp-logic.js');
    const d = L.buildTextDraft({ body: 'Hi Sam, Joe from No Big Deal — your estimate is ready.', reason: 'follow-up' }, ['No Big Deal']);
    ok('R2-3-1 context: a bot text draft gets "Reply STOP to opt out." appended', !!d.body && /Reply STOP to opt out\.$/.test(d.body), JSON.stringify(d));
    const inbox = stripComments(rd('docs/pro/js/agent-inbox.js'));
    ok('R2-3-1 context: the owner sends it from their own phone (an sms: link built from the EDITED textarea)',
      /return 'sms:' \+ num/.test(inbox) && /smsHref\(c\.to, ta \? ta\.value : it\.text/.test(inbox));
    const mcp = stripComments(rd('functions/agent-mcp.js'));
    const fn = blockAt(mcp, 'async function draftAction(request)');
    const cut = fn ? fn.indexOf("data.action !== 'sent'") : -1;
    const sent = cut === -1 ? '' : fn.slice(cut);
    ok('R2-3-1 anchor: draftAction\'s "sent" step is found and still writes the sms_log row', /collection\('sms_log'\)\.add/.test(sent));
    ok('KNOWN BUG R2-3-1 (reported 2026-10-06): a bot text goes out from the owner\'s personal phone promising "Reply STOP to opt out." — that STOP lands on the owner\'s phone and nothing records it — '
      + 'and the "sent" step logs whatever edited body comes back without re-running the company-name, STOP-line or Kentucky claim-wording checks. '
      + 'Expected: an opt-out the system can honour (a "they replied STOP" control, or the business line), and the edited text re-checked before the sms: link is offered',
      !!sent && !/buildTextDraft|claimWordingProblem|hasStopLine|textGate/.test(sent));
  }

  // R2-3-2 ─ texts shared from the phone never check the STOP register
  {
    const ps = stripComments(rd('docs/pro/js/phone-share.js'));
    const share = blockAt(ps, 'async function share(opts)');
    const rules = stripComments(rd('firestore.rules'));
    const optRule = blockAt(rules, 'match /sms_opt_outs/{phone} {');
    ok('R2-3-2 anchor: NBDPhoneShare.share is found and still opens an sms: hand-off', !!share && /smsHref\(o\.phone/.test(share));
    ok('KNOWN BUG R2-3-2 (reported 2026-10-06): NBDPhoneShare.share (deal links while A2P is pending, estimate follow-ups, document links, crew notices) opens the share sheet / Messages '
      + 'with no opt-out lookup, and the browser cannot read sms_opt_outs (rules: read, write: if false). Expected a server check (like agentDraftAction "check") before the hand-off',
      !!share && !/opt.?out|sms_opt_outs|isOptedOut|smsCompliance|httpsCallable/i.test(share)
        && !!optRule && /allow\s+read\s*,\s*write\s*:\s*if\s+false/.test(optRule),
      'rule block: ' + String(optRule).slice(0, 120));
  }

  // R2-3-3 ─ re-approving an AI draft that was already SENT sends it again
  {
    const rules = stripComments(rd('firestore.rules'));
    const drafts = blockAt(rules, 'match /ai_drafts/{draftId}');
    ok('R2-3-3 anchor: the ai_drafts rule is found and still limits the new status to approved / dismissed',
      !!drafts && /request\.resource\.data\.status in \['approved', 'dismissed'\]/.test(drafts));
    ok('KNOWN BUG R2-3-3 (reported 2026-10-06), rules half: the rep update does not require the CURRENT status to be pending — sent → approved is allowed',
      !!drafts && !/resource\.data\.status\s*==/.test(drafts.replace(/request\.resource\.data\.status/g, '')));

    // The trigger, driven for real with stubbed firebase/twilio modules (the
    // tests/sms-send-optout-order.test.js idiom).
    const twilioCalls = [];
    const docs = {};
    const docRef = (p) => ({
      get: async () => ({ exists: docs[p] != null, data: () => docs[p] }),
      set: async (d) => { docs[p] = d; },
      update: async () => {},
      delete: async () => {},
      collection: (n) => db.collection(p + '/' + n),
    });
    const query = () => ({ where: () => query(), orderBy: () => query(), limit: () => query(), get: async () => ({ empty: true, size: 0, docs: [] }) });
    const db = { doc: docRef, collection: (name) => Object.assign(query(), { add: async () => ({ id: 'x' }), doc: (id) => docRef(name + '/' + id) }) };
    const stubs = {
      'firebase-functions/v2/https': { onRequest: (o, h) => ({ __handler: h }) },
      'firebase-functions/v2/firestore': { onDocumentUpdated: (o, h) => ({ __handler: h }), onDocumentCreated: (o, h) => ({ __handler: h }) },
      'firebase-functions/params': { defineSecret: (n) => ({ name: n, value: () => 'secret-' + n }) },
      'firebase-functions/v2': { logger: { error() {}, warn() {}, info() {} } },
      'firebase-admin/firestore': { getFirestore: () => db, FieldValue: { serverTimestamp: () => '__ts__' } },
      'firebase-admin/auth': { getAuth: () => ({ verifyIdToken: async () => ({ uid: 'rep-1' }) }) },
      'firebase-admin/messaging': { getMessaging: () => ({}) },
      './integrations/upstash-ratelimit': { httpRateLimit: async () => true, enforceRateLimit: async () => ({ count: 1 }), clientIp: () => '203.0.113.9' },
      './shared': { requirePaidSubscription: async () => ({ ok: true, plan: 'growth' }), viewOnlyRefusal: () => null },
      './handlers/ai-texting': { generateAIDraft: async () => null, ANTHROPIC_API_KEY: { value: () => '' } },
      './ai-draft-routing': { isPortalDraft: () => false, clampPortalText: (s) => s },
      './portal-reply-effects': { applyRepReplyEffects: async () => {} },
      './integrations/heartbeat': { onSchedule: (o, h) => ({ __handler: h }) },
      twilio: () => ({ messages: { create: async (m) => { twilioCalls.push(m); return { sid: 'SM' + twilioCalls.length }; } } }),
    };
    const realLoad = Module._load;
    Module._load = function (request) { if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request]; return realLoad.apply(this, arguments); };
    let exported = null;
    try {
      for (const f of ['sms-functions.js', 'sms-optout.js', 'phone-utils.js']) delete require.cache[path.join(FN, f)];
      exported = require(path.join(FN, 'sms-functions.js'));
      const after = { status: 'approved', draftText: 'Thanks Sam, Tuesday works.', customerPhone: '(859) 555-0134', userId: 'rep-1', companyId: 'co-1', approvedBy: 'rep-1' };
      const fire = (beforeStatus) => exported.onAiDraftApproved.__handler({
        data: { before: { data: () => ({ status: beforeStatus }) }, after: { data: () => after } },
        params: { leadId: 'lead-1', draftId: 'draft-1' },
      });
      await fire('pending');
      const first = twilioCalls.length;
      await fire('sent');   // a stale second tab (getDocs, no listener) taps Approve again
      ok('R2-3-3 control: the first pending → approved sends exactly one text', first === 1, 'twilio calls ' + first);
      ok('KNOWN BUG R2-3-3 (reported 2026-10-06): onAiDraftApproved only skips before.status === "approved", so a sent → approved write (a stale tab — the panel loads with getDocs) '
        + 'texts the homeowner a SECOND time, outside every sendSMS limit. Expected: send only on pending → approved (and the rule to require resource.data.status == "pending")',
        twilioCalls.length === 2, 'twilio calls ' + twilioCalls.length);
    } catch (e) {
      ok('R2-3-3: the stubbed onAiDraftApproved ran', false, e && e.stack);
    } finally {
      Module._load = realLoad;
      for (const f of ['sms-functions.js', 'sms-optout.js', 'phone-utils.js']) delete require.cache[path.join(FN, f)];
    }
  }

  // R2-3-4 ─ the 5-a-day per-recipient cap hands off to the rep's Messages app
  {
    const src = stripComments(rd('docs/pro/js/nbd-comms.js'));
    // The refusal branch: the `if (` that holds the provider_error carve-out
    // (line 455's 403/401 branch is a different one — the replay path).
    const pe = src.indexOf("plat.code !== 'provider_error')");
    const refuseAt = pe === -1 ? -1 : src.lastIndexOf('if (', pe);
    const refuse = refuseAt === -1 ? null : braceBlock(src, refuseAt);
    const cond = refuseAt === -1 ? '' : src.slice(refuseAt, src.indexOf('{', refuseAt));
    ok('R2-3-4 anchor: the refusal branch (no hand-off) is found and still returns success:false',
      !!refuse && /success:\s*false/.test(refuse));
    ok('KNOWN BUG R2-3-4 (reported 2026-10-06, low): a 429 (incl. sendSMS\'s "max SMS for today" per-recipient cap, "anti-harassment + TCPA defense") is not in the refusal list, '
      + 'so the browser opens Messages with the 6th text filled in ("opening Messages instead"). Expected the per-recipient 429 refused like a 403',
      !!cond && !/429/.test(cond) && /plat\.status === 429 && window\.showToast/.test(src) && /opening Messages instead/.test(src));
  }

  // ════════════════════════════════════════════════════════════════════
  // S — the helpers can fail (rule-prove-the-check-can-fail)
  // ════════════════════════════════════════════════════════════════════
  console.log('\nS — self-checks');
  {
    const s = stripComments("a(); // jobValue\r\n/* jobValue\r\n still */ b();\r\n  // jobValue\r\nconst u = 'https://x.y'; c(); /* x */ d();");
    ok('S: the stripper removes trailing, whole-line and block comments (CRLF input)', !/jobValue/.test(s) && /b\(\);/.test(s) && /d\(\);/.test(s));
    ok('S: a whole-line // comment containing /** does not open a block (firestore.rules has one)', /keep\(\);/.test(stripComments('// the a/b/** subtree\r\nkeep();')));
    ok('S: the stripper keeps a URL inside a string literal', /'https:\/\/x\.y'/.test(s));
    ok('S: braceBlock scopes to the matching brace', braceBlock('if (x) { a { b } c } d', 0) === '{ a { b } c }');
    // A planted fix in each source pin's block must flip it.
    const plantedEdit = "if (editId) { await updateDoc(doc(db,'estimates',editId), {}); await updateDoc(leadRef, { jobValue: 1 }); }";
    ok('S: R2-2-3 detector sees a planted jobValue write in the edit branch', /jobValue/.test(stripComments(blockAt(plantedEdit, 'if (editId) {'))));
    ok('S: R2-2-3 detector ignores a jobValue that is only in a comment', !/jobValue/.test(stripComments("if (editId) { x(); // jobValue later\r\n }")));
    const plantedTier = 'const _tierPlan = (price) => _depRule.fromEstimate(est, { totalCents: price * 100 }); const depositLine';
    ok('S: R2-2-5 detector sees a planted fromEstimate call', /fromEstimate/i.test(plantedTier));
    const plantedRule = stripComments("match /ai_drafts/{draftId} { allow update: if resource.data.status == 'pending' && request.resource.data.status in ['approved', 'dismissed']; }");
    ok('S: R2-3-3 rules detector sees a planted pending guard',
      /resource\.data\.status\s*==/.test(blockAt(plantedRule, 'match /ai_drafts/{draftId}').replace(/request\.resource\.data\.status/g, '')));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e && e.stack); process.exit(1); });
