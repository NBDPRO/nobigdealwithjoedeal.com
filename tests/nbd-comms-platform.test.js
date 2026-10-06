/**
 * tests/nbd-comms-platform.test.js — platform-first NBDComms contract.
 *
 * nbd-comms.js is a browser IIFE. We assert the source contract so CI
 * catches a regression that reverts to client-only mailto / client
 * audit writes (rules deny client sms_log/email_log writes).
 *
 * Zero deps. Run: node tests/nbd-comms-platform.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/nbd-comms.js'), 'utf8');
const INV = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/invoice-pipeline.js'), 'utf8');
const CP = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/claude-proxy.js'), 'utf8');
const SF = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/smart-followup.js'), 'utf8');
const PANEL = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/customer-smart-followup-panel.js'), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name); }
}

console.log('NBDCOMMS PLATFORM — source contract');

ok('posts to Cloud Function sendEmail',
  /FUNCTIONS_BASE\s*\+\s*['"]\/['"]\s*\+\s*fnName/.test(SRC)
  && /_platformPost\(\s*['"]sendEmail['"]/.test(SRC));

ok('posts to Cloud Function sendSMS',
  /_platformPost\(\s*['"]sendSMS['"]/.test(SRC));

ok('attaches Authorization Bearer + X-Firebase-AppCheck when available',
  /Authorization['"]\s*:\s*['"]Bearer /.test(SRC)
  && /X-Firebase-AppCheck/.test(SRC)
  && /__NBD_APP_CHECK/.test(SRC));

ok('does NOT write client audit to emails/sms_log collections',
  !/logAudit\s*\(/.test(SRC)
  && !/addDoc\([^)]*['"]sms_log['"]/.test(SRC)
  && !/addDoc\([^)]*['"]emails['"]/.test(SRC)
  && !/collection\([^)]*['"]sms_log['"]/.test(SRC));

ok('returns mode platform on success',
  /mode:\s*['"]platform['"]/.test(SRC));

ok('falls back to mailto and sms: protocol handoffs',
  /mailto:/.test(SRC) && /sms:/.test(SRC));

ok('respects forceHandoff for callers that want native client only',
  /forceHandoff/.test(SRC));

ok('403/opt-out does not open device Messages for SMS',
  /status === 403/.test(SRC)
  && /opted out|Cannot text/i.test(SRC));

// invoice pipeline passes leadId so server logs thread correctly
ok('invoice sendEmail/sendSMS pass leadId',
  /NBDComms\.sendEmail\(\{[\s\S]{0,400}leadId:\s*invoice\.leadId/.test(INV)
  && /NBDComms\.sendSMS\(\{[\s\S]{0,400}leadId:\s*invoice\.leadId/.test(INV));

// App Check instance exposed from bootstrap sites
const boot = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/dashboard-bootstrap.module.js'), 'utf8');
const auth = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/nbd-auth.js'), 'utf8');
ok('dashboard + nbd-auth expose window.__NBD_APP_CHECK from initializeAppCheck',
  /window\.__NBD_APP_CHECK\s*=\s*initializeAppCheck/.test(boot)
  && /window\.__NBD_APP_CHECK\s*=\s*initializeAppCheck/.test(auth));

// Claude proxy App Check header (W114 AI enrichment needs this in prod)
ok('claude-proxy attaches X-Firebase-AppCheck',
  /X-Firebase-AppCheck/.test(CP) && /__NBD_APP_CHECK/.test(CP));

// Smart follow-up one-tap send
ok('SmartFollowup.executeSuggestion exists and uses NBDComms',
  /function executeSuggestion/.test(SF)
  && /NBDComms\.sendEmail/.test(SF)
  && /NBDComms\.sendSMS/.test(SF)
  && /executeSuggestion,/.test(SF));

ok('customer smart-followup panel uses executeSuggestion for SMS/email',
  /executeSuggestion/.test(PANEL)
  && /data-csf-draft/.test(PANEL));

// Wave: CRM loop complete (items 3–5, 9–10)
const PLH = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/portal-link-helpers.js'), 'utf8');
const CB = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/close-board.js'), 'utf8');
const AJP = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/ask-joe-proactive.js'), 'utf8');
const CTL = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/customer-tasks-ui.js'), 'utf8');
const ES = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/email_system.js'), 'utf8');
const RULES = fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8');
const IDX = fs.readFileSync(path.join(__dirname, '..', 'firestore.indexes.json'), 'utf8');
const SMSF = fs.readFileSync(path.join(__dirname, '..', 'functions/sms-functions.js'), 'utf8');
const EMF = fs.readFileSync(path.join(__dirname, '..', 'functions/email-functions.js'), 'utf8');
const AID = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/customer-ai-drafts-panel.js'), 'utf8');

ok('PortalLinkHelpers SMS/email use NBDComms platform path',
  /NBDComms\.sendSMS/.test(PLH) && /NBDComms\.sendEmail/.test(PLH)
  && /nbd-portal-link-helpers-v2/.test(PLH));

ok('close-board deal send uses NBDComms',
  /NBDComms\.sendSMS/.test(CB) && /NBDComms\.sendEmail/.test(CB));

ok('EmailDrip Send now + buildStageEmail exist',
  /sendStageEmail/.test(SRC) && /buildStageEmail/.test(ES) && /sendStageNow/.test(SRC));

ok('Comm Log supports team companyId query for staff',
  /teamThread/.test(CTL) && /companyId/.test(CTL));

ok('email_log/sms_log rules allow company readers with same companyId',
  /match \/email_log/.test(RULES)
  && /isCompanyReader\(\) && sameCompanyAsResource\(\)/.test(RULES));

ok('indexes include leadId+companyId+date for both logs',
  /"collectionGroup": "email_log"[\s\S]{0,200}"companyId"/.test(IDX)
  && /"collectionGroup": "sms_log"[\s\S]{0,200}"companyId"/.test(IDX));

ok('server log writers stamp companyId',
  /companyId/.test(EMF) && /row\.companyId = companyId/.test(EMF)
  && /companyId/.test(SMSF));

ok('morning briefing injects SmartFollowup actions',
  /smart_followup/.test(AJP) && /SmartFollowup\.computeSuggestion/.test(AJP)
  && /enrichSuggestionAI/.test(AJP));

ok('AI draft send refreshes Comm Log + fires nbd:data-refreshed (smart-followup listens)',
  /loadCommunicationLog/.test(AID) && /nbd:data-refreshed/.test(AID)
  && /ai-draft-sent/.test(AID));

ok('SMS platform errors surface A2P/Twilio guidance',
  /A2P|Twilio/.test(SRC) && /nbd:sms-platform-error/.test(SRC));

// ═══════════════════════════════════════════════════════════════════════
// BEHAVIOUR — sendSMS refusal vs device-Messages handoff (2026-09-18)
//
// A handoff opens the rep's Messages app with the text filled in, so it IS a
// text to that person. It may only follow a server answer that came AFTER the
// opt-out check. The regexes above cannot tell a refusal from a handoff, so
// these run the real nbd-comms.js in a vm against a stubbed fetch and record
// every href the module tries to open. Server side of the same contract:
// tests/sms-send-optout-order.test.js.
// ═══════════════════════════════════════════════════════════════════════
const vm = require('vm');

const D2D = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/d2d-tracker-core-2026b.js'), 'utf8');

function loadComms(respond, phoneCheck) {
  const toasts = [];
  const opened = [];
  const posts = [];
  const events = [];
  const checks = [];
  const window = {
    _user: { getIdToken: async () => 'id-token' },
    // The server 'ok to text?' a hand-off asks first (review R2-3-2, phone-share.js).
    // Default: ok. tests/texting-r2-fixes-2026-10-06.test.js drives the refusals.
    NBDPhoneShare: { checkText: async (o) => { checks.push(o); return phoneCheck ? phoneCheck(o) : { ok: true }; } },
    showToast: (msg, type) => toasts.push({ msg, type }),
    dispatchEvent: (e) => events.push(e),
    location: {
      get href() { return 'https://nobigdealwithjoedeal.com/pro/dashboard.html'; },
      set href(v) { opened.push(v); },
    },
  };
  const document = {
    // _openHandoff builds a hidden <a> and clicks it: the click IS the handoff.
    createElement: () => {
      const a = { style: {}, remove() {} };
      a.click = () => opened.push(a.href);
      return a;
    },
    body: { appendChild() {} },
    addEventListener() {},
  };
  const sandbox = {
    window, document, console,
    location: { hostname: 'nobigdealwithjoedeal.com' },
    fetch: async (url, init) => { posts.push({ url, body: JSON.parse(init.body) }); return respond(); },
    AbortController, setTimeout, clearTimeout,
    CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; },
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'nbd-comms.js' });
  return { NBDComms: window.NBDComms, toasts, opened, posts, events, checks };
}

const jsonRes = (status, body) => () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
// firebase-functions answers an uncaught throw with plain text "Internal Server Error".
const textRes = (status) => () => ({ ok: false, status, json: async () => { throw new SyntaxError('Unexpected token I'); } });
const offline = () => { throw new TypeError('Failed to fetch'); };

async function sms(respond) {
  const h = loadComms(respond);
  const result = await h.NBDComms.sendSMS({ to: '(859) 555-0134', message: 'Hi Sam', leadId: 'lead-1' });
  const smsLinks = h.opened.filter((u) => /^sms:/.test(String(u)));
  return Object.assign(h, { result, smsLinks });
}

/** Source of a named function declaration, by brace matching. */
function extractFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function ' + name + ' not found');
  const open = src.indexOf('{', src.indexOf(')', start));
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error('unbalanced braces in ' + name);
}
const tick = () => new Promise((r) => setImmediate(r));

(async () => {
  console.log('\nNBDCOMMS sendSMS — refusals never build an sms: link');
  {
    const h = await sms(jsonRes(503, { error: 'Could not verify this number can be texted.', code: 'optout_unverified' }));
    ok('503 optout_unverified refuses (success:false, mode:platform)',
      h.result.success === false && h.result.mode === 'platform');
    ok('503 optout_unverified never opens an sms: link', h.smsLinks.length === 0 && h.opened.length === 0);
    ok('_platformPost passes the server code through (error === "optout_unverified")',
      h.result.error === 'optout_unverified');
    ok('the refusal tells the rep nothing was sent (error toast)',
      h.toasts.some((t) => t.type === 'error' && /nothing was sent/i.test(t.msg)));
    ok('the refusal result carries the human message for callers that surface it',
      typeof h.result.message === 'string' && /nothing was sent/i.test(h.result.message));
  }
  {
    const h = await sms(textRes(500));
    ok('plain-text 500 (function threw before/while checking) refuses, no sms: link',
      h.result.success === false && h.result.mode === 'platform' && h.smsLinks.length === 0);
  }
  {
    const h = await sms(jsonRes(504, { error: 'upstream timeout' }));
    ok('any other 5xx without provider_error refuses, no sms: link',
      h.result.success === false && h.smsLinks.length === 0);
  }
  {
    const h = await sms(jsonRes(503, null));
    ok('a JSON null body on a 503 still refuses (not misread as offline → handoff)',
      h.result.success === false && h.result.mode === 'platform' && h.smsLinks.length === 0);
  }
  {
    const h = await sms(jsonRes(403, { error: 'This recipient has opted out of SMS (replied STOP).', code: 'opted_out' }));
    ok('403 opted_out refuses with error "opted_out" and no sms: link',
      h.result.success === false && h.result.error === 'opted_out' && h.smsLinks.length === 0);
    ok('403 toast shows the server sentence', h.toasts.some((t) => t.type === 'error' && /replied STOP/.test(t.msg)));
  }

  console.log('NBDCOMMS sendSMS — handoffs that are still allowed');
  {
    const h = await sms(jsonRes(502, { error: 'Failed to send SMS', code: 'provider_error' }));
    ok('502 provider_error (Twilio failed after the opt-out check) still hands off to sms:',
      h.result.success === true && h.result.mode === 'sms' && h.smsLinks.length === 1);
    ok('the handoff link targets the recipient with the body filled in',
      /^sms:[^?]*859[^?]*\?body=Hi%20Sam$/.test(h.smsLinks[0] || ''));
  }
  {
    const h = await sms(jsonRes(429, { error: 'Daily SMS limit exceeded' }));
    ok('429 still hands off (server now answers 429 only after opt-out passed)',
      h.result.mode === 'sms' && h.smsLinks.length === 1);
  }
  {
    const h = await sms(jsonRes(402, { error: 'An active paid subscription is required.' }));
    ok('402 still hands off (server now answers 402 only after opt-out passed)',
      h.result.mode === 'sms' && h.smsLinks.length === 1);
  }
  {
    const h = await sms(offline);
    // This sandbox loads nbd-comms.js WITHOUT sms-outbox.js, i.e. the "no
    // outbox on this page / no IndexedDB" fallback. With the outbox loaded,
    // offline texts are queued instead — tests/sms-outbox-client.test.js.
    ok('offline / network failure (status 0) with NO outbox on the page keeps the pre-outbox handoff',
      h.result.mode === 'sms' && h.smsLinks.length === 1);
  }
  {
    const h = await sms(jsonRes(200, { success: true, sid: 'SM1' }));
    ok('200 is a platform send with no handoff',
      h.result.success === true && h.result.mode === 'platform' && h.result.sid === 'SM1' && h.opened.length === 0);
  }
  {
    const h = loadComms(textRes(500));
    const r = await h.NBDComms.sendEmail({ to: 'a@b.co', subject: 's', body: 'b' });
    ok('email is untouched: a 500 still hands off to mailto:',
      r.mode === 'mailto' && h.opened.some((u) => /^mailto:/.test(String(u))));
  }

  // ── Consumers: a refusal must stay a refusal downstream ─────────────────
  console.log('CONSUMERS — no consumer turns a refusal back into a handoff');
  {
    // d2d-tracker-core-2026b.js sendFollowUpSMS opened sms: on ANY failure,
    // including the 403 opted_out that NBDComms had just refused.
    // (canTextKnock — the door-knock consent check, 2026-10-05 — is extracted
    // with it; NO_CONSENT_MSG is a const beside it. The knock below carries
    // smsConsent so these checks reach the NBDComms refusal they are about.)
    const factory = new Function('window', 'state', 'SMS_TEMPLATES', '_fillTemplate', 'formatDate', 'NO_CONSENT_MSG',
      extractFunction(D2D, 'canTextKnock') + '\n' + extractFunction(D2D, 'sendFollowUpSMS') + '\nreturn sendFollowUpSMS;');
    async function d2d(result) {
      const opened = [];
      const toasts = [];
      const win = {
        NBDComms: { sendSMS: async () => result },
        open: (u) => opened.push(u),
        showToast: (m, t) => toasts.push({ m, t }),
        _user: { displayName: 'Joe' },
      };
      const send = factory(win, { currentRep: { name: 'Joe' } },
        { follow_up: { body: 'Hi {name}' } }, (b) => b, () => 'soon', 'no consent');
      send({ id: 'knock-1', phone: '(859) 555-0134', homeowner: 'Sam', disposition: 'follow_up', smsConsent: true }, 'follow_up');
      await tick(); await tick();
      return { opened, toasts };
    }
    let r = await d2d({ success: false, mode: 'platform', error: 'opted_out' });
    ok('D2D: an opted_out refusal opens NO sms: link', r.opened.length === 0);
    r = await d2d({ success: false, mode: 'platform', error: 'optout_unverified' });
    ok('D2D: an optout_unverified refusal opens NO sms: link', r.opened.length === 0);
    r = await d2d({ success: false, mode: 'sms', error: 'no-body' });
    // #1660 (FO-1) made NBDComms own the whole outcome on this path: D2D never
    // opens sms: after any NBDComms answer. no-recipient / no-body have nothing
    // to send anyway (sendFollowUpSMS returns early without a phone and its
    // templates always produce a body).
    ok('D2D: a local pre-flight failure (mode sms) opens NO sms: link (nothing to send)',
      r.opened.length === 0);
    r = await d2d({ success: true, mode: 'sms' });
    ok('D2D: a completed NBDComms handoff is not opened a second time', r.opened.length === 0);
  }
  {
    // customer-smart-followup-panel.js fell back to PortalLinkHelpers.smsForLead
    // on ANY failure — re-posting a different message after a refusal.
    const factory = new Function('window', '_dismissedThisSession', 'update',
      extractFunction(PANEL, 'wireActions') + '\nreturn wireActions;');
    async function panel(action, result) {
      const calls = [];
      let handler = null;
      const btn = {
        getAttribute: () => action,
        addEventListener: (ev, fn) => { handler = fn; },
        disabled: false,
      };
      const host = {
        querySelectorAll: (sel) => (sel === '[data-csf-action]' ? [btn] : []),
        querySelector: () => ({ textContent: 'Hi Sam, quick check-in.' }),
      };
      const win = {
        SmartFollowup: {
          computeSuggestion: () => ({ draft: 'x' }),
          executeSuggestion: async () => result,
          recordOutcome: () => {},
        },
        PortalLinkHelpers: {
          smsForLead: () => calls.push('smsForLead'),
          emailForLead: () => calls.push('emailForLead'),
        },
      };
      factory(win, new Set(), () => {})(host, { id: 'lead-1' });
      await handler({ stopPropagation() {} });
      return calls;
    }
    ok('panel: an SMS platform refusal does NOT fall back to smsForLead',
      (await panel('sms', { success: false, mode: 'platform', error: 'optout_unverified' })).length === 0);
    ok('panel: an opted_out refusal does NOT fall back to smsForLead',
      (await panel('sms', { success: false, mode: 'platform', error: 'opted_out' })).length === 0);
    ok('panel: a non-platform SMS failure keeps the smsForLead fallback',
      (await panel('sms', { success: false, error: 'no-phone' })).join() === 'smsForLead');
    ok('panel: no result at all keeps the smsForLead fallback',
      (await panel('sms', null)).join() === 'smsForLead');
    // Email twin (opt-out residuals, 2026-09-22): an email platform refusal
    // fell back to emailForLead, which minted a portal token and sent a
    // DIFFERENT email (the portal-link one) straight after the refusal.
    ok('panel: an email 403 refusal does NOT fall back to emailForLead (or anything else)',
      (await panel('email', { success: false, mode: 'platform', error: 'forbidden' })).length === 0);
    ok('panel: an email 401 refusal does NOT fall back to emailForLead',
      (await panel('email', { success: false, mode: 'platform', error: 'Unauthorized' })).length === 0);
    ok('panel: an SMS refusal never switches channel to email',
      !(await panel('sms', { success: false, mode: 'platform', error: 'opted_out' })).includes('emailForLead'));
    // Controls: the guard is scoped to refusals, not to the email channel.
    ok('panel: a local email pre-flight failure (comms not loaded) keeps the emailForLead fallback',
      (await panel('email', { success: false, error: 'comms-unavailable' })).join() === 'emailForLead');
    ok('panel: no email result at all keeps the emailForLead fallback',
      (await panel('email', null)).join() === 'emailForLead');
    ok('panel: a sent email (mode platform) triggers no fallback',
      (await panel('email', { success: true, mode: 'platform', id: 'em_1' })).length === 0);
    ok('panel: an email handoff (mode mailto) triggers no second send',
      (await panel('email', { success: true, mode: 'mailto' })).length === 0);
  }
  {
    // End to end through the REAL chain: panel wireActions → real
    // SmartFollowup.executeSuggestion → real NBDComms.sendEmail → stubbed
    // fetch answering the server's role refusal (functions/email-functions.js
    // sendEmail: 403 "Your account role cannot send email").
    const panelFactory = new Function('window', '_dismissedThisSession', 'update',
      extractFunction(PANEL, 'wireActions') + '\nreturn wireActions;');
    const execFactory = new Function('window', 'computeSuggestion', 'recordOutcome', 'leadName',
      'async ' + extractFunction(SF, 'executeSuggestion') + '\nreturn executeSuggestion;');
    async function chain(respond) {
      const h = loadComms(respond);
      const calls = [];
      const outcomes = [];
      let handler = null;
      const btn = { getAttribute: () => 'email', addEventListener: (ev, fn) => { handler = fn; }, disabled: false };
      const host = {
        querySelectorAll: (sel) => (sel === '[data-csf-action]' ? [btn] : []),
        querySelector: () => ({ textContent: 'Hi Sam, quick check-in on the roof.' }),
      };
      const sfWin = { NBDComms: h.NBDComms };
      const exec = execFactory(sfWin, () => null, (id, o) => outcomes.push(id), () => 'Sam Lee');
      const win = {
        SmartFollowup: {
          computeSuggestion: () => ({ action: 'email', channel: 'email', draft: 'x' }),
          executeSuggestion: exec,
          recordOutcome: () => {},
        },
        PortalLinkHelpers: {
          smsForLead: () => calls.push('smsForLead'),
          emailForLead: () => calls.push('emailForLead'),
        },
      };
      panelFactory(win, new Set(), () => {})(host, { id: 'lead-1', firstName: 'Sam', email: 'sam@example.com', phone: '8595550134' });
      await handler({ stopPropagation() {} });
      return Object.assign(h, { calls, outcomes, btn });
    }
    let r = await chain(jsonRes(403, { error: 'Your account role cannot send email' }));
    ok('e2e email 403: exactly ONE sendEmail POST (no second send attempt)',
      r.posts.length === 1 && /\/sendEmail$/.test(r.posts[0].url), r.posts.map((p) => p.url).join());
    ok('e2e email 403: the POST carried leadId (server email_log stamp)', r.posts[0] && r.posts[0].body.leadId === 'lead-1');
    ok('e2e email 403: no emailForLead / smsForLead fallback', r.calls.length === 0);
    ok('e2e email 403: no mailto: or sms: opened', r.opened.length === 0);
    ok('e2e email 403: the rep is told why (error toast with the server reason)',
      r.toasts.some((t) => t.type === 'error' && /role cannot send email/.test(t.msg)));
    ok('e2e email 403: not recorded as "acted" on the suggestion', r.outcomes.length === 0);
    ok('e2e email 403: the Email button is re-enabled (rep can retry deliberately)', r.btn.disabled === false);
    r = await chain(jsonRes(401, { error: 'Unauthorized' }));
    ok('e2e email 401: one POST, no fallback, nothing opened',
      r.posts.length === 1 && r.calls.length === 0 && r.opened.length === 0);
    // Control: the same chain on success sends once and records the action.
    r = await chain(jsonRes(200, { success: true, id: 'em_1' }));
    ok('e2e email 200 (control): one POST, no fallback, recorded as acted',
      r.posts.length === 1 && r.calls.length === 0 && r.outcomes.length === 1);
  }
  // invoice-pipeline.js: display-only — the refusal's `error` is now a code
  // ('opted_out'), so the thrown message must prefer the sentence the rep saw.
  // sendInvoice needs Firestore end to end, so this one stays a source pin.
  ok('invoice SMS failure surfaces result.message before the machine code',
    /smsResult\s*&&\s*\(smsResult\.message\s*\|\|\s*smsResult\.error\)/.test(INV));

  console.log('\n──────────────────────────────────────────────────');
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('\nFailures:');
    fails.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
})().catch((e) => {
  console.error('suite crashed:', (e && e.stack) || e);
  process.exit(1);
});
