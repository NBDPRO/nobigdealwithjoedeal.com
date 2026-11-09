/**
 * call-brief-ui.js — the Call Brief review sheet (Call to Close P0, 2026-11-09).
 * Design: documentation/projects/CALL-TO-CLOSE-DESIGN-2026-11-09.md §4, §5.2.
 *
 * Loaded on the first tap of "Draft from this call" (customer-calls.js on the
 * customer page, call-center-view.js on #/calls), never at boot: no <script>
 * tag anywhere. Its stylesheet (css/call-brief.css) loads with it.
 *
 * The sheet shows what the callBrief callable returned (every fact with the
 * words that were said) and offers one tap per item, each through an
 * existing writer:
 *   1. Summary: editable; "Add to timeline" appends one activity note
 *      (callBriefDecide), after a confirm, because notes cannot be undone.
 *   2. Field diff: current → from the call, quote, said / implied, Accept /
 *      Edit / Skip. Fill-empty only (a filled field says so and offers Skip).
 *      Carrier, claim # and an insurance job type carry the Kentucky
 *      insurance-job warning and confirm first; the adjuster meeting says it
 *      goes on the calendar and confirms first. One field per tap.
 *   3. Promises: a You / Them toggle on each (the model's guess, which Jo
 *      fixes), the kind and the date, and an explicit Add + a one-line
 *      confirm, because a promise marks the call handled (callCenterAction
 *      promise, the next free slot 1-5, never slot 0).
 *   4. Follow-up: only when the call's date differs from the customer's
 *      (NBDFollowUpDeck.setFollowUp, with its undo; followup-deck.js is
 *      lazy-loaded on the customer page).
 *   5. Mark handled (callCenterAction handled).
 *   6. Stage (P1): "Suggests: …, because '…'". A plain forward move is one
 *      tap through the CRM's own stage writer (progressStage on the customer
 *      page, moveCard on #/calls), with every gate that writer has.
 *      Inspected, install_complete and Lost / Archived / Cancelled ask first,
 *      naming why (Lost takes a reason, typed with what was said beside it); a stage
 *      that sets an appointment never moves from here (it opens the normal
 *      place); a signed / job / won stage never moves. call-to-close-logic.js
 *      stagePlan decides; the move is logged in callBriefDecide decisions[]
 *      only once the writer moved it.
 *   7. Draft proposal (P0b): DocPreflight.open('proposal', leadId) with only
 *      the Project Description seeded, and only when the customer has none
 *      (it persists to lead.scopeOfWork). Scope items are never seeded: the
 *      call's scope shows as a "From the call" list to copy in.
 *   8. Start estimate / Start repair quote (P1, design §5.1, Q8): the
 *      estimate builder with the call's CHOICES filled in (estimate-v2-ui.js
 *      callPrefill). On the dashboard it opens the builder here; on the
 *      customer page it goes to /pro/dashboard.html?lead=<id>&callBrief=<id>.
 *   9. Follow-up message (P1, design §5.3): built ONLY from the items the
 *      person accepted (promises, the follow-up date, the adjuster meeting),
 *      in fixed phrases (never the model's words). A text needs written
 *      texting consent on file (tcpaConsent + the server's tcpaConsentAt, as
 *      sms-consent-declined.js consentBasis); a spoken "you can text me" is
 *      not consent. A text goes through NBDPhoneShare.share (the server's
 *      ok-to-text check: STOP, Do Not Text, consent, switch, texting hours;
 *      then the phone's Messages, where the person presses Send); an email
 *      opens the mail app with the draft written. Copy for either.
 *  10. Objections (P1, §6 #6; Q4: kept in the brief, never lead fields): a
 *      tag per objection / named competitor with the words said and a
 *      playbook reply from fixed phrases (PLAYBOOK; a tenant may override a
 *      reply through companyProfile.callPlaybook), copy-only.
 *  11. Who decides (P2, §6 #5; Q4: kept in the brief, never lead fields):
 *      the people the call says must agree, approve or sign, labelled with
 *      the words used for them ("my husband", "the HOA") and the quote.
 *      Heard on the call (no speaker labels), copy-only, nothing written.
 *  One filled button (P2): the act being confirmed, else the follow-up
 *  message's send, else a one-tap stage move, else the drafts button.
 * Nothing is pre-ticked, there is no Apply-all, nothing is sent, priced or
 * signed, and no stage moves without a tap. Everything shown is escaped.
 *
 * P1 (2026-11-09): a quote Whisper was unsure of (the call's segIndex,
 * functions/call-brief-logic.js unsureQuotes) says "Unsure"; a field whose
 * value has a digit and came from such a quote (retype) has no Accept: the
 * person listens and types it, and the server refuses it otherwise.
 * transcribe() is the cards' "Transcribe now" (callTranscribeNow), in this
 * same lazy file so the cards stay small.
 *
 * P2 (2026-11-09, design §6 #11): openVisit() is the same sheet for an
 * in-person walkthrough (a visit recording filed on the customer), from the
 * timeline's "Brief this walkthrough" (call-timeline.js). Every callable gets
 * { visitId, visitUid } instead of a callId; there is no "This call" /
 * handled and no promise Add (a walkthrough's promises were filed as tasks
 * when it was attached); the proposal's list says "From the walkthrough" and
 * holds the scope facts whose words were said (scope.visitFacts).
 *
 * No inline handlers (CSP script-src-attr 'none'): one delegated listener.
 */
(function () {
  'use strict';
  if (window.NBDCallBrief) return;

  var FUNCTIONS_SDK = '/assets/vendor/firebase/10.12.2/firebase-functions.js';
  var CSS_HREF = '/pro/css/call-brief.css?v=2';
  var FOLLOWUP_JS = '/pro/js/followup-deck.js?v=2';
  var CTC_JS = '/pro/js/call-to-close-logic.js?v=1';
  var INSURANCE_WARN = 'This makes the job an insurance job. Kentucky notices and the cancellation form will apply.';
  // The meeting date feeds the calendar feed and the Google Calendar sync
  // (google-calendar-logic WATCHED), so it is labelled and always confirmed.
  // (No homeowner portal reads it today; the design's label assumed one.)
  var CALENDAR_WARN = 'This puts the adjuster meeting on your calendar, and on Google Calendar when it is connected.';
  var FIELD_ORDER = ['insCarrier', 'claimNumber', 'dateOfLoss', 'adjusterName', 'adjusterMeetingYmd', 'damageType', 'jobType'];
  var FIELD_LABEL = {
    insCarrier: 'Insurance carrier', claimNumber: 'Claim #', dateOfLoss: 'Date of loss', adjusterName: 'Adjuster',
    adjusterMeetingYmd: 'Adjuster meeting', damageType: 'Damage', jobType: 'Job type',
  };
  // The lead field each brief field fills (= functions/call-brief-logic.js LEAD_FIELD).
  var LEAD_FIELD = {
    insCarrier: 'insCarrier', claimNumber: 'claimNumber', dateOfLoss: 'dateOfLoss', adjusterName: 'adjusterName',
    adjusterMeetingYmd: 'adjusterMeetingDate', damageType: 'damageType', jobType: 'jobType',
  };
  // Every name the CRM reads a field under; filled under any of them counts
  // as filled (= functions/call-brief-logic.js LEAD_FIELD_ALIASES).
  var LEAD_FIELD_ALIASES = {
    insCarrier: ['insCarrier', 'insuranceCarrier', 'insuranceCompany', 'carrier'], claimNumber: ['claimNumber'], dateOfLoss: ['dateOfLoss'],
    adjusterName: ['adjusterName'], adjusterMeetingYmd: ['adjusterMeetingDate'], damageType: ['damageType', 'damage'], jobType: ['jobType'],
  };
  var KIND_LABEL = { callback: 'Call back', estimate: 'Send estimate', text: 'Text', order: 'Order materials', permit: 'Check on permit', waiting: 'Waiting on them' };
  var KINDS = ['callback', 'estimate', 'text', 'order', 'permit', 'waiting'];
  var MAX_SLOT = 5;  // callCenterAction promise slots 1-5 (slot 0 is the card's Promise button)
  // The follow-up message's fixed phrases (design §5.3): what the person
  // accepted, never the model's wording, never a number but a date.
  var MSG_PHRASE = { callback: "I'll call you back", estimate: "I'll send over your estimate", text: "I'll text you", order: "I'll get your materials ordered", permit: "I'll check on the permit" };
  var MSG_SUBJECT = 'Following up on our call';
  // Objection playbook (design §6 #6): fixed replies, copy-only, tenant-neutral.
  // A tenant may replace one through companyProfile.callPlaybook.<kind>.
  var PLAYBOOK = {
    price: "That's fair to ask. The price comes from your roof's measurements and the materials you pick, and I'm glad to walk you through every line. If another package fits your budget better, we can look at that together.",
    timing: 'No rush at all. When would be a better time for me to check back with you?',
    trust: 'Good question to ask. I can send you our license and insurance details and reviews from homeowners near you, so you can check us out first.',
    insurance: 'Your insurance company decides what the claim covers. I can show you the damage we documented, and you can share our photos and report with your adjuster.',
    spouse: "Of course. Would a time when you can both be there work? I'm happy to go over everything together.",
    competitor: 'Getting more than one quote makes sense. When you compare, check that each one covers the same materials, tear-off and warranty, and ask me anything that looks different.',
    other: 'Thanks for telling me. What would help you feel good about the next step?',
  };
  var OBJ_LABEL = { price: 'Price', timing: 'Timing', trust: 'Trust', insurance: 'Insurance', spouse: 'Spouse or partner', competitor: 'Competitor', other: 'Other' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function blank(v) { return v == null || (typeof v === 'string' && v.trim() === ''); }
  function leadValue(lead, key) {
    var names = LEAD_FIELD_ALIASES[key] || [LEAD_FIELD[key]];
    for (var n = 0; n < names.length; n++) if (!blank((lead || {})[names[n]])) return lead[names[n]];
    return '';
  }
  function ymdOf(v) { var m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v || '')); return m ? m[1] : ''; }
  function fmtYmd(v) {
    var y = ymdOf(v);
    if (!y) return '';
    var d = new Date(y + 'T12:00:00');
    return isNaN(d) ? y : d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  }
  function fmtDur(sec) { var s = Math.max(0, Math.round(Number(sec) || 0)); return Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's'; }
  function leadName(l) { l = l || {}; return ((l.firstName || '') + ' ' + (l.lastName || '')).trim() || l.name || l.address || 'Customer'; }
  function uid() { return (window.auth && window.auth.currentUser && window.auth.currentUser.uid) || ''; }

  // ── pure helpers (also what the tests read) ────────────────────────────
  function warnFor(key, value) {
    if (key === 'insCarrier' || key === 'claimNumber') return INSURANCE_WARN;
    if (key === 'jobType' && value === 'insurance') return INSURANCE_WARN;
    if (key === 'adjusterMeetingYmd') return CALENDAR_WARN;
    return '';
  }
  /** One row per field the brief proposes: current → proposed, never pre-ticked. */
  function fieldRows(brief, lead) {
    var f = (brief && brief.fields) || {};
    var L = lead || {};
    // A field the customer already has with the same value says nothing new.
    var same = function (a, b) { return String(a == null ? '' : a).trim().toLowerCase() === String(b == null ? '' : b).trim().toLowerCase(); };
    return FIELD_ORDER.filter(function (k) { return f[k] && !blank(f[k].value) && !same(leadValue(L, k), f[k].value); }).map(function (k) {
      var current = leadValue(L, k);
      return {
        key: k, label: FIELD_LABEL[k], current: blank(current) ? '' : String(current), proposed: String(f[k].value),
        spoken: f[k].spoken || '', quote: f[k].quote || '', conf: f[k].conf === 'implied' ? 'implied' : 'said',
        warn: blank(current) ? warnFor(k, f[k].value) : '', filled: !blank(current), isDate: k === 'dateOfLoss' || k === 'adjusterMeetingYmd',
        unsure: f[k].unsure === true, retype: f[k].retype === true,
      };
    });
  }
  /** The follow-up change, only when the call's date differs from the customer's. */
  function followUpChange(brief, lead) {
    var to = ymdOf(brief && brief.followUp && brief.followUp.value);
    if (!to) return null;
    var from = ymdOf(lead && lead.followUp);
    if (to === from) return null;
    var ch = { to: to, from: from, quote: brief.followUp.quote || '' };
    if (brief.followUp.retype === true) ch.retype = true;
    return ch;
  }
  /** "From the call" scope lines (shown, never seeded into a list field). on: 'on the call' | 'at the walkthrough'. */
  function scopeHints(brief, on) {
    var s = (brief && brief.scope) || {};
    var where = on || 'on the call';
    var out = [];
    if (s.service && s.service.value) out.push(s.service.value);
    var m = s.mentions || {};
    ['gutters', 'chimney', 'skylight', 'decking'].forEach(function (k) { if (m[k] === true) out.push(k.charAt(0).toUpperCase() + k.slice(1) + ' mentioned ' + where); });
    if (s.stories && s.stories.value) out.push(s.stories.value + '-story house (said ' + where + (s.stories.retype === true ? ', but hard to hear: check it' : '') + ')');
    if (s.tierInterest && s.tierInterest.value) out.push('Asked about the ' + s.tierInterest.value + ' package');
    var said = {};
    if (s.stories && s.stories.quote) said[s.stories.quote] = true;   // already the "N-story house" line
    (s.saidQuantities || []).forEach(function (q) { said[q.quote] = true; out.push('Said: "' + q.quote + '"'); });
    // P2: a walkthrough's scope facts whose words were said (server-grounded), each once.
    (s.visitFacts || []).forEach(function (f) { if (f && f.quote && !said[f.quote]) { said[f.quote] = true; out.push('Said: "' + f.quote + '"'); } });
    return out;
  }
  // The damage words the seed may say; anything else the model wrote is left out.
  var SEED_DAMAGE = ['hail', 'wind', 'storm', 'water', 'leak', 'tree', 'fire', 'ice'];
  function kindFromWords(v) {
    var t = String(v || '').toLowerCase();
    if (/replac|re-?roof|new roof|tear ?off/.test(t)) return 'replace';
    if (/repair|patch|\bfix/.test(t)) return 'repair';
    return '';
  }
  /**
   * The Project Description seed: fixed phrases only, picked by the brief's
   * choices (workKind, or a repair / replace word in the grounded service),
   * a damage word from SEED_DAMAGE and the mention flags. The model's own
   * wording never reaches the seed (review 2026-11-09), so no prose and no
   * numbers; '' when the customer already has one, or the kind is unknown.
   */
  function projectSeed(brief, lead) {
    if (!brief || (lead && !blank(lead.scopeOfWork))) return '';
    var f = brief.fields || {};
    var s = brief.scope || {};
    var kind = (f.workKind && f.workKind.value) || kindFromWords(s.service && s.service.value);
    var what = kind === 'repair' ? 'Roof repair' : kind === 'replace' ? 'Complete roof replacement' : '';
    if (!what) return '';
    var adds = [];
    var m = s.mentions || {};
    if (m.gutters) adds.push('gutters');
    if (m.chimney) adds.push('chimney flashing');
    if (m.skylight) adds.push('skylights');
    if (m.decking) adds.push('decking as needed');
    var dt = String((f.damageType && f.damageType.value) || '').toLowerCase();
    var dmg = SEED_DAMAGE.filter(function (w) { return new RegExp('\\b' + w).test(dt); })[0] || '';
    return what + (dmg ? ' for ' + dmg + ' damage' : '') + (adds.length ? ', including ' + adds.join(', ') : '') + '.';
  }

  function truthy(v) { return v === true || v === 'true' || v === 1 || v === '1'; }
  /**
   * May this customer get a text draft? Written consent only: tcpaConsent
   * true WITH the server's tcpaConsentAt stamp (functions/sms-consent-declined.js
   * consentBasis treats an unstamped true as no evidence). Nothing said on a
   * call counts. Do Not Text / opted out / a declined form refuse too.
   */
  function textConsent(lead) {
    var l = lead || {};
    if (String(l.phone || l.phoneDigits || '').replace(/\D/g, '').length < 10) return { ok: false, why: 'No phone number on file for this customer, so there is no text draft.' };
    if (truthy(l.doNotContact) || truthy(l.dnc) || truthy(l.doNotText) || truthy(l.smsOptOut) || truthy(l.smsOptedOut)) return { ok: false, why: 'This customer is on Do Not Text or opted out, so there is no text draft. Call or email them.' };
    if (l.tcpaConsent === false) return { ok: false, why: 'This customer said no to texts on their form, so there is no text draft. Call or email them.' };
    if (!(l.tcpaConsent === true && l.tcpaConsentAt != null)) {
      return { ok: false, why: 'No written texting consent on file for this customer, so there is no text draft. Saying "you can text me" on a call is not consent: texts go only to people who ticked the texting box on a form. Use the email draft or call them.' };
    }
    return { ok: true, why: '' };
  }
  function emailOk(lead) {
    var l = lead || {};
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(l.email || '').trim())) return { ok: false, why: 'No email address on file for this customer, so there is no email draft.' };
    if (truthy(l.doNotContact) || truthy(l.dnc) || truthy(l.emailOptOut) || truthy(l.emailUnsubscribed) || truthy(l.unsubscribed)) return { ok: false, why: 'This customer asked not to be emailed, so there is no email draft.' };
    return { ok: true, why: '' };
  }
  function msgDate(ymd) {
    var y = ymdOf(ymd);
    if (!y) return '';
    var d = new Date(y + 'T12:00:00');
    return isNaN(d) ? '' : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }
  function msgLine(it) {
    var d = msgDate(it.ymd);
    if (it.kind === 'followUp') return d ? "I'll check in with you on " + d + '.' : '';
    if (it.kind === 'meeting') return d ? 'See you at the adjuster meeting on ' + d + '.' : '';
    if (it.kind === 'waiting') return 'When you have a chance, send over what we talked about' + (d ? ' by ' + d : '') + '.';
    return MSG_PHRASE[it.kind] ? MSG_PHRASE[it.kind] + (d ? ' by ' + d : '') + '.' : '';
  }
  /**
   * The follow-up draft from accepted items only (pure): { text, subject,
   * body } or null when nothing was accepted. Fixed phrases; the first name
   * and the company come from the CRM, the dates from what was accepted.
   */
  function followUpDraft(items, lead, company, what) {
    var lines = [];
    (items || []).forEach(function (it) { var l = msgLine(it); if (l && lines.indexOf(l) === -1) lines.push(l); });
    if (!lines.length) return null;
    var first = String((lead && lead.firstName) || '').trim().split(/\s+/)[0].slice(0, 30);
    var co = String(company || '').trim().slice(0, 80);
    var hi = first ? 'Hi ' + first + ',' : 'Hi,';
    var thanks = what === 'visit' ? 'thanks for having us out' : 'thanks for the call';
    return {
      text: hi + ' ' + thanks + '. ' + lines.join(' ') + (co ? ' \u2014 ' + co + (/[.!?]$/.test(co) ? '' : '.') : '') + ' Reply STOP to opt out.',
      subject: MSG_SUBJECT,
      body: hi + '\n\n' + thanks.charAt(0).toUpperCase() + thanks.slice(1) + '. Here is what we agreed:\n\n' + lines.map(function (l) { return '- ' + l; }).join('\n') +
        '\n\nIf anything changes, reply here or give me a call.' + (co ? '\n\n' + co : ''),
    };
  }
  /** Objection and competitor tags with a playbook reply (pure). overrides: companyProfile.callPlaybook. */
  function objectionTags(brief, overrides) {
    var b = brief || {};
    var own = overrides && typeof overrides === 'object' ? overrides : {};
    var reply = function (k) { var v = own[k]; return typeof v === 'string' && v.trim() && v.length <= 400 ? v.trim() : PLAYBOOK[k]; };
    var out = [];
    (Array.isArray(b.objections) ? b.objections : []).forEach(function (o) {
      if (o && Object.prototype.hasOwnProperty.call(PLAYBOOK, o.kind)) out.push({ kind: o.kind, label: OBJ_LABEL[o.kind], quote: String(o.quote || ''), reply: reply(o.kind) });
    });
    if (b.competitor && b.competitor.named === true && !out.some(function (t) { return t.kind === 'competitor'; })) {
      out.push({ kind: 'competitor', label: 'Competitor named', quote: String(b.competitor.quote || ''), reply: reply('competitor') });
    }
    return out;
  }
  // Who decides (P2): a role's plain words when the call gave no name or label.
  var ROLE_WORDS = { owner: 'The homeowner', spouse: 'Spouse or partner', tenant: 'The tenant', adjuster: 'The adjuster', other: 'Someone else' };
  /** The deciders the brief heard (pure): [{ label, quote, unsure }], said > name > role. */
  function whoDecides(brief) {
    var out = [], seen = {};
    ((brief && Array.isArray(brief.people)) ? brief.people : []).forEach(function (p) {
      if (!p || p.decides !== true || !String(p.quote || '').trim()) return;
      var label = String(p.said || '').trim() || String(p.name || '').trim() || ROLE_WORDS[p.role] || ROLE_WORDS.other;
      var key = label.toLowerCase();
      if (seen[key]) return;
      seen[key] = 1;
      out.push({ label: label, quote: String(p.quote), unsure: p.unsure === true });
    });
    return out.slice(0, 6);
  }
  function whoLine(d) { return d.label + ': \u201c' + d.quote + '\u201d'; }
  function profile() { return window._companyProfile || {}; }
  function tenantName() { var p = profile(), b = p.brand || {}; return String(b.name || p.companyName || p.name || '').trim(); }

  // ── state ──────────────────────────────────────────────────────────────
  var S = null;  // { callId, call, lead, leadId, page, brief, decisions, gen, loading, error, done:{}, busy:{}, confirm:'', edit:{}, prom:[], fuUndo, onChange, visit? }
  var dlg = null;
  // P2 walkthrough: S.visit = { visitId, visitUid } (S.callId is visit_<visitId>, the brief's id).
  function isVisit() { return !!(S && S.visit); }
  function src() { return isVisit() ? 'walkthrough' : 'call'; }
  /** What names this brief on every callable: the call, or the walkthrough. */
  function ids() { return isVisit() ? { visitId: S.visit.visitId, visitUid: S.visit.visitUid } : { callId: S.callId }; }

  // Decisions are keyed by index ('promise:1', 'field:k'), so only the ones
  // made on the brief shown count (gen = its generatedAtMs); a regenerated
  // brief starts clean. Slots used by any earlier brief stay used (usedSlots).
  function decided(item) {
    var ds = (S && S.decisions) || [];
    for (var i = ds.length - 1; i >= 0; i--) if (ds[i] && ds[i].item === item && (S.gen == null || ds[i].gen === S.gen)) return ds[i];
    return null;
  }
  function initPromises() {
    S.prom = ((S.brief && S.brief.promises) || []).map(function (p, i) {
      var d = decided('promise:' + i);
      // A date heard in a hard-to-hear stretch (retype) starts empty: the person types it.
      return { who: p.who === 'them' ? 'them' : 'jo', kind: p.kind, modelKind: p.kind, dueYmd: p.retype === true ? '' : (p.dueYmd || ''), done: !!(d && d.decision === 'accept'), skipped: !!(d && d.decision === 'skip') };
    });
  }

  /**
   * What the person accepted on THIS brief, for the follow-up message: this
   * session's taps (S.done) or a decision logged on this brief (decided()
   * already drops another generation's). A skip or an untouched item never
   * counts. Promise who / kind / date are the person's choices, not the model's.
   */
  function msgItems() {
    if (!S || !S.brief) return [];
    var accepted = function (item) {
      var d = S.done[item];
      if (d && d !== 'busy') return d.decision === 'accept' ? { session: true } : null;
      var p = decided(item);
      return p && p.decision === 'accept' ? { value: String(p.finalValue || '') } : null;
    };
    var mine = [], theirs = [], out = [];
    (S.brief.promises || []).forEach(function (p, i) {
      var a = accepted('promise:' + i);
      if (!a) return;
      var who, kind, ymd;
      if (a.session && S.prom[i]) { who = S.prom[i].who; kind = S.prom[i].kind; ymd = S.prom[i].dueYmd; }
      else {
        var m = /^(jo|them) ([a-z]+)(?: (\d{4}-\d{2}-\d{2}))?/.exec(a.value || '');
        if (!m) return;
        who = m[1]; kind = m[2]; ymd = m[3] || '';
      }
      if (who === 'them' || kind === 'waiting') theirs.push({ kind: 'waiting', ymd: ymdOf(ymd) });
      else if (MSG_PHRASE[kind]) mine.push({ kind: kind, ymd: ymdOf(ymd) });
    });
    var meet = accepted('field:adjusterMeetingYmd');
    if (meet) { var my = ymdOf(meet.session ? (S.lead || {})[LEAD_FIELD.adjusterMeetingYmd] : meet.value); if (my) out.push({ kind: 'meeting', ymd: my }); }
    var fu = S.fuUndo ? { value: S.fuUndo.to } : accepted('followUp');
    // The follow-up's Undo is not logged, so a logged accept counts only while
    // the customer still carries that date (an undone one is not promised).
    if (fu && !fu.session) { var fy = ymdOf(fu.value); if (fy && fy === ymdOf((S.lead || {}).followUp)) out.push({ kind: 'followUp', ymd: fy }); }
    return mine.concat(out, theirs);
  }

  // ── render ─────────────────────────────────────────────────────────────
  function btn(label, act, extra, cls) {
    // One filled button per sheet (P2): a btn-orange ask is filled only for the act render() picked.
    if (cls === 'btn-orange' && S && S.primary !== act) cls = 'btn-ghost';
    return '<button type="button" class="btn ' + (cls || 'btn-ghost') + '" data-cb-act="' + esc(act) + '"' + (extra || '') + '>' + esc(label) + '</button>';
  }
  /**
   * The sheet's one filled button: the Yes of the confirm being asked, else
   * the follow-up message's send (when it renders), else a one-tap stage
   * move, else the drafts card's button (Draft proposal on the customer page,
   * Start estimate on the Call Center).
   */
  function primaryAct() {
    var c = S.confirm || '';
    if (c === 'summary') return 'summary-yes';
    if (c === 'stage') return 'stage-yes';
    if (/^field:/.test(c)) return 'accept-yes';
    if (/^promise:/.test(c)) return 'promise-yes';
    var draft = msgDraftNow();
    if (draft) {
      var ch = msgChannel(draft);
      if (ch === 'text' ? textConsent(S.lead).ok : emailOk(S.lead).ok) return ch === 'text' ? 'msg-text' : 'msg-email';
    }
    var plan = S.brief && S.brief.stage ? stagePlanNow() : null;
    if (plan && plan.kind === 'one-tap' && stageWriter()) return 'stage-move';
    return S.page === 'customer' ? 'proposal' : 'estimate';
  }
  function quoteHtml(q, unsure) {
    if (!q) return '';
    return '<blockquote class="cb-quote' + (unsure ? ' is-unsure' : '') + '">' + (unsure ? '<span class="cb-unsure">Unsure: hard to hear on the recording.</span> ' : '') + '&ldquo;' + esc(q) + '&rdquo;</blockquote>';
  }
  function statusFor(item) {
    if (S.err && S.err[item]) return '<div class="cb-err" role="alert">' + esc(S.err[item]) + '</div>';
    var d = S.done[item] || decided(item);
    if (!d) return '';
    if (d === 'busy') return '<div class="cb-meta">Saving…</div>';
    return d.decision === 'skip' ? '<div class="cb-skipped">Skipped</div>' : '<div class="cb-done">' + esc(d.label || 'Done') + '</div>';
  }
  function isSettled(item) { var d = S.done[item] || decided(item); return !!(d && d !== 'busy'); }

  function renderHeader() {
    var c = S.call || {};
    var when = c.startedAtMs ? new Date(c.startedAtMs).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
    var filer = c.attachedBy || c.movedBy;
    var filed = filer ? (filer === uid() ? 'Filed by you' : 'Filed by a teammate') : '';
    var meta = [filed, when, c.durationSec ? fmtDur(c.durationSec) : ''].filter(Boolean).join(' · ');
    var who = S.mode === 'tx' ? 'Transcribe now: ' + (S.leadId ? leadName(S.lead) : (c.contactName || 'this call')) : 'From this ' + src() + ': ' + leadName(S.lead);
    return '<div class="cb-head"><div><h2 class="cb-title" id="cbTitle">' + esc(who) + '</h2>' +
      '<div class="cb-meta">' + esc(meta) + (c.urgent ? ' <span class="cb-badge is-urgent">Urgent</span>' : '') + '</div></div>' +
      '<button type="button" class="btn btn-ghost cb-close" data-cb-act="close" aria-label="Close">✕</button></div>';
  }

  function renderBanners() {
    var b = S.brief || {};
    var t = b.transcriptOk || {};
    var out = '';
    if (t.reliable === false) out += '<div class="cb-banner is-danger" role="status">Transcript unreliable, listen to the recording. Only the summary is shown' + (t.why ? ': ' + esc(t.why) : '.') + '</div>';
    if (t.cutOff) out += '<div class="cb-banner" role="status">The transcript ends mid-call.</div>';
    if (b.flags && b.flags.injection) out += '<div class="cb-banner" role="status">Part of this call reads like instructions to a computer. Nothing was taken from those words.</div>';
    if (b.flags && b.flags.lowConfidence) out += '<div class="cb-banner" role="status">Parts of this call were hard to hear. Those quotes say Unsure, and you type any number from them yourself.</div>';
    return out;
  }

  function renderSummary() {
    var sm = (S.brief && S.brief.summary) || {};
    var item = 'summary';
    var settled = isSettled(item);
    var confirming = S.confirm === item;
    return '<div class="cb-sec" role="group" aria-labelledby="cbSumH"><h3 class="cb-sec-title" id="cbSumH">Summary</h3>' +
      '<label class="cb-field-lbl" for="cbSummary">What the ' + src() + ' was about' + (sm.inferred ? ' (inferred: no quote backs it)' : '') + '</label>' +
      '<textarea class="cb-text" id="cbSummary" data-cb-input="summary"' + (settled ? ' disabled' : '') + '>' + esc(S.summaryText != null ? S.summaryText : (sm.text || '')) + '</textarea>' +
      ((sm.quotes || []).length ? '<div class="cb-quotes">' + sm.quotes.map(function (q, i) { return quoteHtml(q, (sm.unsure || []).indexOf(i) !== -1); }).join('') + '</div>' : '') +
      (settled ? statusFor(item) : confirming
        ? '<div class="cb-warn">Timeline notes cannot be undone. Add this summary to the timeline?</div><div class="cb-acts">' + btn('Add note', 'summary-yes', '', 'btn-orange') + btn('Cancel', 'cancel') + '</div>'
        : '<div class="cb-acts">' + btn('Add to timeline', 'summary') + '</div>' + statusFor(item)) +
      '</div>';
  }

  function renderFields() {
    var rows = fieldRows(S.brief, S.lead);
    if (!rows.length) return '';
    return '<div class="cb-sec" role="group" aria-labelledby="cbFieldH"><h3 class="cb-sec-title" id="cbFieldH">Customer details from the ' + src() + '</h3>' +
      '<div class="cb-meta">Fills empty fields only, one at a time. Nothing is filled until you tap Accept.</div>' +
      rows.map(function (r) {
        var item = 'field:' + r.key;
        var settled = isSettled(item);
        var editing = S.edit[item] != null;
        var shown = r.isDate ? fmtYmd(r.proposed) + (r.spoken ? ' ("' + r.spoken + '")' : '') : r.proposed;
        var acts;
        if (settled) acts = statusFor(item);
        else if (S.confirm === item) {
          acts = '<div class="cb-warn">' + esc(r.warn) + ' Fill it in' + (r.retype && S.edit[item] ? ' as ' + esc(S.edit[item]) : '') + '?</div><div class="cb-acts">' + btn('Yes, fill it in', 'accept-yes', ' data-k="' + esc(r.key) + '"', 'btn-orange') + btn('Cancel', 'cancel') + '</div>';
        } else if (r.filled) {
          acts = '<div class="cb-meta">Already filled in on the customer. Change it on the customer card if it is wrong.</div><div class="cb-acts">' + btn('Skip', 'skip', ' data-k="' + esc(r.key) + '"') + '</div>' + statusFor(item);
        } else if (r.retype) {
          // Digits from a hard-to-hear quote: no Accept, the person types them.
          acts = '<label class="cb-field-lbl" for="cbEdit-' + esc(r.key) + '">Type it from the recording</label>' +
            '<input class="cb-input" id="cbEdit-' + esc(r.key) + '" data-cb-input="edit" data-k="' + esc(r.key) + '"' + (r.isDate ? ' type="date"' : ' type="text" maxlength="120" autocomplete="off"') + ' value="' + esc(S.edit[item] || '') + '">' +
            '<div class="cb-acts">' + btn('Save', 'edit-save', ' data-k="' + esc(r.key) + '"') + btn('Skip', 'skip', ' data-k="' + esc(r.key) + '"') + '</div>' + statusFor(item);
        } else if (editing) {
          acts = '<label class="cb-field-lbl" for="cbEdit-' + esc(r.key) + '">Your value</label>' +
            '<input class="cb-input" id="cbEdit-' + esc(r.key) + '" data-cb-input="edit" data-k="' + esc(r.key) + '"' + (r.isDate ? ' type="date"' : ' type="text" maxlength="120"') + ' value="' + esc(S.edit[item]) + '">' +
            '<div class="cb-acts">' + btn('Save', 'edit-save', ' data-k="' + esc(r.key) + '"') + btn('Cancel', 'cancel', ' data-k="' + esc(r.key) + '"') + '</div>' + statusFor(item);
        } else {
          acts = '<div class="cb-acts">' + btn('Accept', 'accept', ' data-k="' + esc(r.key) + '"') + btn('Edit', 'edit', ' data-k="' + esc(r.key) + '"') + btn('Skip', 'skip', ' data-k="' + esc(r.key) + '"') + '</div>' + statusFor(item);
        }
        return '<div class="cb-card" data-cb-row="' + esc(item) + '"><div class="cb-row-head"><span class="cb-label">' + esc(r.label) + '</span><span class="cb-badge">' + esc(r.conf) + '</span></div>' +
          '<div class="cb-diff"><span class="cb-now">Now: ' + esc(r.current ? (r.isDate ? fmtYmd(r.current) : r.current) : 'empty') + '</span> → ' + (r.retype && !settled ? 'heard as <strong>' + esc(shown) + '</strong>, but it was hard to hear. Listen and type it.' : '<strong>' + esc(shown) + '</strong>') + '</div>' +
          quoteHtml(r.quote, r.unsure) + (r.warn && !settled && S.confirm !== item ? '<div class="cb-warn">' + esc(r.warn) + '</div>' : '') + acts + '</div>';
      }).join('') + '</div>';
  }

  function renderPromises() {
    var ps = (S.brief && S.brief.promises) || [];
    if (!ps.length) return '';
    // A walkthrough's promises were filed as tasks when it was attached (visit-capture.js): shown, never added twice.
    if (isVisit()) {
      return '<div class="cb-sec" role="group" aria-labelledby="cbPromH"><h3 class="cb-sec-title" id="cbPromH">Promises at the walkthrough</h3>' +
        '<div class="cb-meta">These are already tasks on this customer, made when the walkthrough was filed. Check them in Tasks.</div>' +
        ps.map(function (p) { return '<div class="cb-card"><div class="cb-row-head"><span class="cb-label">' + esc(p.text) + '</span>' + (p.dueSpoken ? '<span class="cb-meta">' + esc(p.dueSpoken) + '</span>' : '') + '</div>' + quoteHtml(p.quote, p.unsure === true) + '</div>'; }).join('') + '</div>';
    }
    return '<div class="cb-sec" role="group" aria-labelledby="cbPromH"><h3 class="cb-sec-title" id="cbPromH">Promises on the call</h3>' +
      '<div class="cb-meta">Check who promised it. Adding a promise makes a dated task and marks the call handled. Not handled puts the call back; the task stays until it is done.</div>' +
      ps.map(function (p, i) {
        var st = S.prom[i];
        var item = 'promise:' + i;
        var head = '<div class="cb-row-head"><span class="cb-label">' + esc(p.text) + '</span>' + (p.dueSpoken ? '<span class="cb-meta">' + esc(p.dueSpoken) + '</span>' : '') + '</div>' + quoteHtml(p.quote, p.unsure === true);
        if (st.done || st.skipped || isSettled(item)) return '<div class="cb-card">' + head + (statusFor(item) || '<div class="cb-done">Added</div>') + '</div>';
        var toggle = '<div class="cb-toggle" role="radiogroup" aria-label="Who promised it">' +
          '<button type="button" role="radio" aria-checked="' + (st.who === 'jo') + '" tabindex="' + (st.who === 'jo' ? 0 : -1) + '" data-cb-act="who" data-i="' + i + '" data-who="jo">You</button>' +
          '<button type="button" role="radio" aria-checked="' + (st.who === 'them') + '" tabindex="' + (st.who === 'them' ? 0 : -1) + '" data-cb-act="who" data-i="' + i + '" data-who="them">Them</button></div>';
        var kinds = KINDS.map(function (k) { return '<option value="' + k + '"' + (k === st.kind ? ' selected' : '') + '>' + esc(KIND_LABEL[k]) + '</option>'; }).join('');
        var fields = '<div class="cb-grid"><label class="cb-field-lbl" for="cbKind-' + i + '">What<select class="cb-select" id="cbKind-' + i + '" data-cb-input="kind" data-i="' + i + '">' + kinds + '</select></label>' +
          '<label class="cb-field-lbl" for="cbDue-' + i + '">' + (st.kind === 'waiting' ? 'Chase on' : 'Due') + '<input class="cb-input" type="date" id="cbDue-' + i + '" data-cb-input="due" data-i="' + i + '" value="' + esc(st.dueYmd) + '"></label></div>' +
          (p.retype === true ? '<div class="cb-meta">The date was hard to hear on the recording. Listen and type it.</div>' : '');
        var acts = S.confirm === item
          ? '<div class="cb-warn">Add "' + esc(KIND_LABEL[st.kind] || st.kind) + '"' + (st.dueYmd ? ' for ' + esc(fmtYmd(st.dueYmd)) : '') + '? It adds a new task (it never changes a promise already on the customer) and marks the call handled.</div><div class="cb-acts">' + btn('Add promise', 'promise-yes', ' data-i="' + i + '"', 'btn-orange') + btn('Cancel', 'cancel') + '</div>'
          : '<div class="cb-acts">' + btn('Add', 'promise', ' data-i="' + i + '"') + btn('Skip', 'promise-skip', ' data-i="' + i + '"') + '</div>';
        return '<div class="cb-card" data-cb-row="' + esc(item) + '">' + head + toggle + fields + acts + statusFor(item) + '</div>';
      }).join('') + '</div>';
  }

  function renderFollowUp() {
    var ch = followUpChange(S.brief, S.lead);
    if (!ch && !S.fuUndo) return '';
    var item = 'followUp';
    var body;
    if (S.fuUndo) body = '<div class="cb-done">Follow-up set to ' + esc(fmtYmd(S.fuUndo.to)) + '</div><div class="cb-acts">' + btn('Undo', 'followup-undo') + '</div>';
    // A date heard in a hard-to-hear stretch is never one tap: listen and set it yourself.
    else if (ch.retype) body = '<div class="cb-diff"><span class="cb-now">Now: ' + esc(ch.from ? fmtYmd(ch.from) : 'none') + '</span> → heard as <strong>' + esc(fmtYmd(ch.to)) + '</strong></div>' + quoteHtml(ch.quote, true) +
      '<div class="cb-meta">The date was hard to hear on the recording. Listen and set the follow-up yourself.</div>' + statusFor(item);
    else body = '<div class="cb-diff"><span class="cb-now">Now: ' + esc(ch.from ? fmtYmd(ch.from) : 'none') + '</span> → <strong>' + esc(fmtYmd(ch.to)) + '</strong></div>' + quoteHtml(ch.quote) +
      (isSettled(item) ? statusFor(item) : '<div class="cb-acts">' + btn('Change follow-up', 'followup') + '</div>' + statusFor(item));
    return '<div class="cb-sec" role="group" aria-labelledby="cbFuH"><h3 class="cb-sec-title" id="cbFuH">Follow-up</h3><div class="cb-card">' + body + '</div></div>';
  }

  // The customer's stage now, and which CRM writer can move it from here
  // ('' = none: the sheet only offers the normal place to change it).
  function boardLead() { return (window._leads || []).filter(function (l) { return l && l.id === S.leadId; })[0] || null; }
  function currentStage() {
    var live = S.page === 'customer' ? window._currentStage : (boardLead() || {}).stage;
    return live || (S.lead && S.lead.stage) || '';
  }
  function stageWriter() {
    // progressStage(target, opts) since P1; an older cached copy takes no target.
    if (S.page === 'customer') return typeof window.progressStage === 'function' && window.progressStage.length >= 1 ? 'customer' : '';
    return typeof window.moveCard === 'function' && boardLead() ? 'board' : '';
  }
  function stagePlanNow() {
    var st = S.brief && S.brief.stage;
    var C = window.NBDCallToClose;
    if (!(st && C && typeof C.stagePlan === 'function')) return null;
    // The tenant's own pipeline order decides what a move back is.
    var cp = window._companyProfile;
    var orders = typeof C.tenantStageOrders === 'function' ? C.tenantStageOrders(cp && cp.pipelines) : [];
    return C.stagePlan(st, currentStage(), orders);
  }
  // The reason as the end of "…, because …": an ordinary first word goes
  // lower case; a name ("Joe looked…"), "I" or an acronym keeps its capital.
  var PLAIN_START = /^(the|a|an|they|he|she|it|we|you|there|this|that|these|those|their|his|her|its|our|your|both|customer|homeowner|caller|owner|insurance|adjuster|roof|after|before|since|when|on|in)\b/i;
  function becauseText(reason) {
    var r = String(reason).trim().replace(/\.$/, '');
    return PLAIN_START.test(r) && !/^[A-Z]{2}/.test(r) ? r.charAt(0).toLowerCase() + r.slice(1) : r;
  }

  function renderObjections() {
    var tags = objectionTags(S.brief, profile().callPlaybook);
    if (!tags.length) return '';
    return '<div class="cb-sec" role="group" aria-labelledby="cbObjH"><h3 class="cb-sec-title" id="cbObjH">Objections ' + (isVisit() ? 'at the walkthrough' : 'on the call') + '</h3>' +
      '<div class="cb-meta">What they pushed back on, in their words, with a reply you can copy. Kept in this brief only: nothing goes on the customer and nothing is sent.</div>' +
      tags.map(function (t, i) {
        return '<div class="cb-card"><div class="cb-row-head"><span class="cb-tag">' + esc(t.label) + '</span></div>' + quoteHtml(t.quote) +
          '<div class="cb-reply">' + esc(t.reply) + '</div><div class="cb-acts">' + btn('Copy reply', 'obj-copy', ' data-i="' + i + '"') + '</div>' +
          (S.objCopied[i] ? '<div class="cb-done" role="status">' + esc(S.objCopied[i]) + '</div>' : '') + '</div>';
      }).join('') + '</div>';
  }

  function renderWhoDecides() {
    var list = whoDecides(S.brief);
    if (!list.length) return '';
    var copied = S.dmCopied || {};
    var heard = isVisit() ? 'Heard at the walkthrough' : 'Heard on the call';
    return '<div class="cb-sec" role="group" aria-labelledby="cbWhoH"><h3 class="cb-sec-title" id="cbWhoH">Who decides</h3>' +
      '<div class="cb-meta">' + heard + ': who has a say, in the words that were said. The recording has no speaker labels, so check it. Kept in this brief only: it is never written to the customer and nothing is sent.</div>' +
      list.map(function (d, i) {
        return '<div class="cb-card"><div class="cb-row-head"><span class="cb-label">' + esc(d.label) + '</span><span class="cb-badge">' + heard + '</span></div>' + quoteHtml(d.quote, d.unsure) +
          '<div class="cb-acts">' + btn('Copy', 'dm-copy', ' data-i="' + i + '" aria-label="' + esc('Copy: ' + d.label) + '"') + '</div>' +
          (copied[i] ? '<div class="cb-done" role="status">' + esc(copied[i]) + '</div>' : '') + '</div>';
      }).join('') +
      '<div class="cb-acts">' + btn('Copy list', 'dm-copy-all', ' aria-label="Copy the Who decides list"') + '</div>' + (copied.all ? '<div class="cb-done" role="status">' + esc(copied.all) + '</div>' : '') + '</div>';
  }

  function msgDraftNow() { return followUpDraft(msgItems(), S.lead, tenantName(), isVisit() ? 'visit' : ''); }
  function msgChannel(draft) { return S.msg.ch || (textConsent(S.lead).ok || !emailOk(S.lead).ok ? 'text' : 'email'); }
  function renderMessage() {
    var draft = msgDraftNow();
    var body;
    if (!draft) {
      body = '<div class="cb-meta">Accept ' + (isVisit() ? '' : 'a promise, ') + 'the follow-up date or the adjuster meeting above, then a message built from them shows here in fixed wording you can edit.</div>';
    } else {
      var ch = msgChannel(draft);
      var toggle = '<div class="cb-toggle" role="radiogroup" aria-label="Send it as">' +
        '<button type="button" role="radio" aria-checked="' + (ch === 'text') + '" data-cb-act="msg-channel" data-ch="text">Text</button>' +
        '<button type="button" role="radio" aria-checked="' + (ch === 'email') + '" data-cb-act="msg-channel" data-ch="email">Email</button></div>';
      var inner;
      if (ch === 'text') {
        var tc = textConsent(S.lead);
        inner = !tc.ok ? '<div class="cb-banner" role="status">' + esc(tc.why) + '</div>'
          : '<label class="cb-field-lbl" for="cbMsgText">Text message</label><textarea class="cb-text" id="cbMsgText" data-cb-input="msg-text" maxlength="600">' + esc(S.msg.text != null ? S.msg.text : draft.text) + '</textarea>' +
            '<div class="cb-acts">' + btn('Check and open in Messages', 'msg-text', '', 'btn-orange') + btn('Copy', 'msg-copy') + '</div>' +
            '<div class="cb-meta">Checks Do Not Text, consent and texting hours first, then opens Messages with this written. You press Send there.</div>';
      } else {
        var em = emailOk(S.lead), tcE = textConsent(S.lead);
        inner = (tcE.ok ? '' : '<div class="cb-meta">' + esc(tcE.why) + '</div>') + (!em.ok ? '<div class="cb-banner" role="status">' + esc(em.why) + '</div>'
          : '<label class="cb-field-lbl" for="cbMsgSubj">Subject</label><input class="cb-input" type="text" id="cbMsgSubj" data-cb-input="msg-subject" maxlength="120" value="' + esc(S.msg.subject != null ? S.msg.subject : draft.subject) + '">' +
            '<label class="cb-field-lbl" for="cbMsgBody">Email</label><textarea class="cb-text" id="cbMsgBody" data-cb-input="msg-body" maxlength="2000">' + esc(S.msg.body != null ? S.msg.body : draft.body) + '</textarea>' +
            '<div class="cb-acts">' + btn('Open in Mail', 'msg-email', '', 'btn-orange') + btn('Copy', 'msg-copy') + '</div>' +
            '<div class="cb-meta">Opens your mail app with this written. You press Send there; the CRM does not send it.</div>');
      }
      body = '<div class="cb-meta">Built only from what you accepted, in fixed wording. Nothing is sent until you send it yourself.</div>' + toggle + inner +
        (S.msg.err ? '<div class="cb-err" role="alert">' + esc(S.msg.err) + '</div>' : '') + (S.msg.done ? '<div class="cb-done" role="status">' + esc(S.msg.done) + '</div>' : '') + (S.msg.note ? '<div class="cb-meta" role="status">' + esc(S.msg.note) + '</div>' : '');
    }
    return '<div class="cb-sec" role="group" aria-labelledby="cbMsgH"><h3 class="cb-sec-title" id="cbMsgH">Follow-up message</h3><div class="cb-card">' + body + '</div></div>';
  }

  function renderStage() {
    var st = S.brief && S.brief.stage;
    if (!st) return '';
    var picker = S.page === 'customer'
      ? btn('Change the stage…', 'stage')
      : '<a class="btn btn-ghost" href="/pro/customer.html?id=' + encodeURIComponent(S.leadId) + '">Open the customer to change it</a>';
    var plan = stagePlanNow();
    var canMove = plan && (plan.kind === 'one-tap' || plan.kind === 'confirm') && stageWriter();
    var to = esc(st.label);
    var body;
    if (plan && plan.kind === 'none') body = '<div class="cb-meta">' + esc(plan.why || 'The customer is already at this stage.') + '</div>';
    else if (!canMove) {
      body = '<div class="cb-meta">' + esc((plan && (plan.kind === 'flow' || plan.kind === 'refuse') && plan.why) || 'Nothing moves from here. You change the stage yourself.') + '</div><div class="cb-acts">' + picker + '</div>';
    } else if (plan.kind === 'one-tap') {
      body = '<div class="cb-meta">One tap moves it through the usual stage change, with its checks.</div><div class="cb-acts">' + btn('Move to ' + st.label, 'stage-move', '', 'btn-orange') + picker + '</div>';
    } else if (S.confirm === 'stage') {
      body = '<div class="cb-warn">' + esc(plan.why) + ' Move to ' + to + '?</div>' +
        // The box starts empty: the customer's words (shown above) are a hint,
        // never the CRM's loss reason by default.
        (plan.needsReason ? '<label class="cb-field-lbl" for="cbLostReason">Reason</label><input class="cb-input" id="cbLostReason" type="text" maxlength="300" data-cb-input="lostReason" placeholder="Why it was lost, in your words" value="' + esc(S.lostReason != null ? S.lostReason : '') + '">' : '') +
        '<div class="cb-acts">' + btn('Yes, move to ' + st.label, 'stage-yes', '', 'btn-orange') + btn('Cancel', 'cancel') + '</div>';
    } else {
      body = '<div class="cb-meta">' + esc(plan.why) + '</div><div class="cb-acts">' + btn('Move to ' + st.label + '…', 'stage-ask') + picker + '</div>';
    }
    return '<div class="cb-sec" role="group" aria-labelledby="cbStageH"><h3 class="cb-sec-title" id="cbStageH">Stage</h3><div class="cb-card">' +
      '<div class="cb-diff">Suggests: <strong>' + to + '</strong>' + (st.reason ? ', because ' + esc(becauseText(st.reason)) : '') + '</div>' + quoteHtml(st.quote, st.unsure === true) +
      body + statusFor('stage-move') + '</div></div>';
  }

  // Start estimate (P1): fixed label, the repair wording only for a repair call.
  function estimateDraftHtml() {
    var b = S.brief || {};
    if (b.transcriptOk && b.transcriptOk.reliable === false) return '';
    var wk = b.fields && b.fields.workKind && b.fields.workKind.value;
    var label = wk === 'repair' ? 'Start repair quote' : 'Start estimate';
    return '<div class="cb-meta">Opens the estimate builder with the job type, work kind, tier, stories, layers and add-ons ' + (isVisit() ? 'named at the walkthrough' : 'the caller named') + ', each marked from call. ' +
      (wk === 'repair' ? 'Repair templates are offered for a quick quote. ' : '') +
      'Measurements and prices come from you and your price book; nothing is saved until you press Save.</div>' +
      (S.err && S.err['draft:estimate'] ? '<div class="cb-err" role="alert">' + esc(S.err['draft:estimate']) + '</div>' : '') +
      '<div class="cb-acts">' + btn(label, 'estimate', '', S.page === 'customer' ? 'btn-ghost' : 'btn-orange') + '</div>';
  }

  function renderDrafts() {
    var hints = scopeHints(S.brief, isVisit() ? 'at the walkthrough' : '');
    var seed = projectSeed(S.brief, S.lead);
    var body = estimateDraftHtml() + (S.page === 'customer'
      ? '<div class="cb-meta">Opens the proposal' + (seed ? '. If its project description is empty, it is filled in from this ' + src() : ' with its usual details') + '. You finish it, nothing is sent.</div>' +
        (hints.length ? '<div class="cb-meta">From the ' + src() + ' (copy what fits into the scope list):</div><ul class="cb-list">' + hints.map(function (h) { return '<li>' + esc(h) + '</li>'; }).join('') + '</ul>' : '') +
        '<div class="cb-acts">' + btn('Draft proposal', 'proposal', '', 'btn-orange') + '</div>'
      : '<div class="cb-acts"><a class="btn btn-ghost" href="/pro/customer.html?id=' + encodeURIComponent(S.leadId) + '">Open the customer to draft a proposal</a></div>');
    return '<div class="cb-sec" role="group" aria-labelledby="cbDraftH"><h3 class="cb-sec-title" id="cbDraftH">Drafts</h3><div class="cb-card">' + body + '</div></div>';
  }

  function renderHandled() {
    if (isVisit()) return '';
    var c = S.call || {};
    var item = 'handled';
    var body = c.handledAtMs || isSettled(item)
      ? '<div class="cb-done">This call is marked handled.</div>'
      : '<div class="cb-acts">' + btn('Mark handled', 'handled') + '</div><div class="cb-meta">Takes the call off "needs you". Not handled on the call card puts it back.</div>' + statusFor(item);
    return '<div class="cb-sec" role="group" aria-labelledby="cbHandH"><h3 class="cb-sec-title" id="cbHandH">This call</h3><div class="cb-card">' + body + '</div></div>';
  }

  function render() {
    if (!dlg || !S) return;
    var body;
    if (S.mode === 'tx') body = S.loading ? '<div class="cb-loading" role="status">Transcribing this call now. A long call can take a minute or two.</div>'
      : S.error ? '<div class="cb-banner is-danger" role="alert">' + esc(S.error) + '</div>'
      : '<div class="cb-banner" role="status">' + esc(S.txMsg) + '</div>';
    else if (S.loading) body = '<div class="cb-loading" role="status">' + (isVisit() ? 'Reading the walkthrough…' : 'Reading the call… Notes arrive 30-60 minutes after the call.') + '</div>';
    else if (S.error) body = '<div class="cb-banner is-danger" role="alert">' + esc(S.error) + '</div>';
    // One sheet, in the order a person works a call (P1 integration): what was
    // said, the fields, promises and follow-up date, this call, the stage,
    // the objections, then what to send or start (follow-up message, estimate,
    // proposal). Drafts stays last: its card ends at the sheet's foot.
    else {
      S.primary = primaryAct();
      body = renderBanners() + renderSummary() + renderFields() + renderPromises() + renderFollowUp() + renderHandled() + renderStage() + renderObjections() + renderWhoDecides() + renderMessage() + renderDrafts();
    }
    dlg.innerHTML = renderHeader() + '<div class="cb-scroll">' + body + '</div>' +
      '<div class="cb-foot"><span class="cb-meta">Nothing here is sent, priced or signed.</span>' + btn('Close', 'close') + '</div>';
  }

  // ── server calls ───────────────────────────────────────────────────────
  async function callable(name, data, opts) {
    if (!window._functions || !window._httpsCallable) {
      var mod = await import(FUNCTIONS_SDK);
      window._functions = mod.getFunctions();
      window._httpsCallable = mod.httpsCallable;
    }
    var res = await (opts ? window._httpsCallable(window._functions, name, opts) : window._httpsCallable(window._functions, name))(data);
    return res && res.data;
  }
  function errText(e) { return (e && e.message ? String(e.message).replace(/^FirebaseError:\s*/, '') : '') || 'That did not work. Try again.'; }
  async function decide(item, decision, extra) {
    return callable('callBriefDecide', Object.assign(ids(), { item: item, decision: decision }, extra || {}));
  }
  function mark(item, decision, label) { S.done[item] = { decision: decision, label: label }; if (S.err) delete S.err[item]; }
  function fail(item, e) { delete S.done[item]; S.err = S.err || {}; S.err[item] = errText(e); }
  function changed() { if (S && typeof S.onChange === 'function') { try { S.onChange(); } catch (_) { /* the card reloads itself */ } } }

  async function acceptField(key, value, confirmed) {
    var item = 'field:' + key;
    S.done[item] = 'busy'; S.confirm = ''; render();
    try {
      var w = warnFor(key, value != null ? value : ((fieldRows(S.brief, S.lead).filter(function (r) { return r.key === key; })[0] || {}).proposed));
      var extra = { confirmedInsurance: confirmed === true && w === INSURANCE_WARN };
      if (confirmed === true && w === CALENDAR_WARN) extra.confirmedCalendar = true;
      if (value != null) extra.value = value;
      // A hard-to-hear value the person typed (the server refuses it otherwise).
      var r0 = fieldRows(S.brief, S.lead).filter(function (r) { return r.key === key; })[0];
      if (value != null && r0 && r0.retype) extra.retyped = true;
      await decide(item, 'accept', extra);
      var row = fieldRows(S.brief, S.lead).filter(function (r) { return r.key === key; })[0];
      var final = value != null ? value : row && row.proposed;
      if (S.lead) S.lead[LEAD_FIELD[key]] = final;
      mark(item, 'accept', 'Filled in');
      delete S.edit[item];
      changed();
    } catch (e) { fail(item, e); }
    render();
  }

  async function onAct(b) {
    var a = b.getAttribute('data-cb-act');
    var k = b.getAttribute('data-k');
    var i = Number(b.getAttribute('data-i'));
    if (a === 'close') { close(); return; }
    // An edit box's Cancel closes that box; a confirm's Cancel closes only the
    // confirm and keeps what was typed (a retype box has no prefill).
    if (a === 'cancel') { if (k) delete S.edit['field:' + k]; else { S.confirm = ''; S.lostReason = null; } render(); return; }
    if (a === 'summary') { S.confirm = 'summary'; render(); return; }
    if (a === 'summary-yes') {
      var text = S.summaryText != null ? S.summaryText : ((S.brief.summary || {}).text || '');
      S.done.summary = 'busy'; S.confirm = ''; render();
      try { await decide('summary', 'accept', { value: text }); mark('summary', 'accept', 'Added to the timeline'); changed(); } catch (e) { fail('summary', e); }
      render(); return;
    }
    if (a === 'accept') {
      var r = fieldRows(S.brief, S.lead).filter(function (x) { return x.key === k; })[0];
      if (!r) return;
      if (r.warn) { S.confirm = 'field:' + k; render(); return; }
      acceptField(k, null, false); return;
    }
    if (a === 'accept-yes') { acceptField(k, S.edit['field:' + k] != null ? S.edit['field:' + k] : null, true); return; }
    if (a === 'edit') {
      var er = fieldRows(S.brief, S.lead).filter(function (x) { return x.key === k; })[0];
      S.edit['field:' + k] = er ? er.proposed : ''; render();
      var inp = dlg.querySelector('#cbEdit-' + k); if (inp) inp.focus();
      return;
    }
    if (a === 'edit-save') {
      var v = String(S.edit['field:' + k] || '').trim();
      if (!v) return;
      var wr = warnFor(k, v);
      if (wr) { S.confirm = 'field:' + k; render(); return; }
      acceptField(k, v, false); return;
    }
    if (a === 'skip') {
      var it = 'field:' + k;
      S.done[it] = 'busy'; render();
      try { await decide(it, 'skip'); mark(it, 'skip'); } catch (e) { fail(it, e); }
      render(); return;
    }
    if (isVisit() && /^(who|promise|promise-yes|promise-skip|handled)$/.test(a)) return;
    if (a === 'who') { setWho(i, b.getAttribute('data-who')); return; }
    if (a === 'promise') { S.confirm = 'promise:' + i; render(); return; }
    if (a === 'promise-skip') {
      S.done['promise:' + i] = 'busy'; render();
      try { await decide('promise:' + i, 'skip'); S.prom[i].skipped = true; mark('promise:' + i, 'skip'); } catch (e) { fail('promise:' + i, e); }
      render(); return;
    }
    if (a === 'promise-yes') {
      var ps = S.prom[i], p = S.brief.promises[i];
      var item = 'promise:' + i;
      S.done[item] = 'busy'; S.confirm = ''; render();
      try {
        var data = { id: S.callId, action: 'promise', kind: ps.kind, why: p.text };
        if (ps.dueYmd) data.dueYmd = ps.dueYmd;
        // P2: the server refuses a retype promise's heard-as date unless it
        // was typed. A retype date box starts empty, so a date in it was typed.
        data.briefPromise = i;
        if (p.retype === true && ps.dueYmd) data.retyped = true;
        if (ps.kind === 'waiting') data.waitingOn = 'customer';
        var res = await addPromise(data);
        ps.done = true;
        mark(item, 'accept', 'Added' + (res && res.dueDate ? ', due ' + fmtYmd(res.dueDate) : ''));
        if (S.call) S.call.handledAtMs = Date.now();
        decide(item, 'accept', { value: ps.who + ' ' + ps.kind + ' ' + (ps.dueYmd || ''), slot: data.slot }).catch(function () { /* the promise itself is saved */ });
        changed();
      } catch (e) { fail(item, e); }
      render(); return;
    }
    if (a === 'followup' || a === 'followup-undo') { followUp(a === 'followup-undo'); return; }
    if (a === 'handled') {
      S.done.handled = 'busy'; render();
      try {
        await callable('callCenterAction', { id: S.callId, action: 'handled' });
        if (S.call) S.call.handledAtMs = Date.now();
        mark('handled', 'accept', 'Marked handled');
        decide('handled', 'accept').catch(function () {});
        changed();
      } catch (e) { fail('handled', e); }
      render(); return;
    }
    if (a === 'stage') {
      decide('stage', 'skip', { value: 'opened the stage picker' }).catch(function () {});
      close();
      var edit = document.querySelector('[data-action="openEditCustomerModal"]');
      if (edit) edit.click();
      return;
    }
    if (a === 'stage-ask') {
      var sp = stagePlanNow();
      if (sp && sp.kind === 'confirm') { S.confirm = 'stage'; render(); }
      return;
    }
    if (a === 'stage-move' || a === 'stage-yes') { moveStage(a); return; }
    if (a === 'proposal') { draftProposal(); return; }
    if (a === 'msg-channel') { S.msg.ch = b.getAttribute('data-ch') === 'email' ? 'email' : 'text'; S.msg.err = ''; S.msg.done = ''; S.msg.note = ''; render(); return; }
    if (a === 'msg-text' || a === 'msg-email') { sendMessage(a === 'msg-text' ? 'text' : 'email'); return; }
    if (a === 'msg-copy') {
      var dr = msgDraftNow();
      if (!dr) return;
      var ch = msgChannel(dr);
      var words = ch === 'email' ? (S.msg.body != null ? S.msg.body : dr.body) : (S.msg.text != null ? S.msg.text : dr.text);
      S.msg.done = (await copyText(words)) ? 'Copied.' : 'Could not copy. Select the text and copy it.';
      render(); return;
    }
    if (a === 'obj-copy') {
      var tag = objectionTags(S.brief, profile().callPlaybook)[i];
      if (!tag) return;
      S.objCopied[i] = (await copyText(tag.reply)) ? 'Copied' : 'Could not copy. Select the text and copy it.';
      render(); return;
    }
    if (a === 'dm-copy' || a === 'dm-copy-all') {
      var who = whoDecides(S.brief);
      var one = a === 'dm-copy' ? who[i] : null;
      if (a === 'dm-copy' && !one) return;
      var txt = one ? whoLine(one) : 'Who decides (heard on the call):\n' + who.map(function (d) { return '- ' + whoLine(d); }).join('\n');
      S.dmCopied = S.dmCopied || {};
      S.dmCopied[one ? i : 'all'] = (await copyText(txt)) ? 'Copied' : 'Could not copy. Select the text and copy it.';
      render(); return;
    }
    if (a === 'estimate') { startEstimate(); }
  }

  /**
   * The brief's stage, through the CRM's own writer. One tap only for a plain
   * forward move; a confirm-list stage only from its Yes; never an
   * appointment, signed, job or won stage. The sheet closes first (the
   * writer may open its own sheet or confirm), and the decision is logged
   * only once the customer actually moved.
   */
  async function moveStage(a) {
    var plan = stagePlanNow();
    var how = plan ? stageWriter() : '';
    var mode = plan && plan.kind === 'one-tap' && a === 'stage-move' ? 'one-tap'
      : plan && plan.kind === 'confirm' && a === 'stage-yes' && S.confirm === 'stage' ? 'confirmed' : '';
    if (!mode || !how) return;
    var reason = plan.needsReason ? String(S.lostReason != null ? S.lostReason : '').trim().slice(0, 300) : '';
    if (plan.needsReason && !reason) { S.err = S.err || {}; S.err['stage-move'] = 'Give a reason first.'; render(); return; }
    var who = ids(), leadId = S.leadId, onChange = S.onChange, from = currentStage();
    var opts = { asked: mode === 'confirmed' };
    if (reason) opts.lostReason = reason;
    // The page's Undo toast: log it, so decisions[] never keeps a bare accept.
    opts.onUndone = function () {
      callable('callBriefDecide', Object.assign({}, who, { item: 'stage', decision: 'skip', undone: true })).catch(function () { /* the move back is saved */ });
    };
    close();
    var moved = false;
    try {
      if (how === 'customer') moved = (await window.progressStage(plan.key, opts)) === true;
      // moveCard resolves true only once its write committed (or the card
      // already sat at the target); a lost race reloads _leads, so the board's
      // copy of the lead says nothing about whether THIS tap moved it.
      else moved = (await window.moveCard(leadId, plan.key, reason ? { lostReason: reason } : undefined)) === true;
    } catch (e) {
      if (typeof window.showToast === 'function') window.showToast('The stage did not move: ' + errText(e), 'error');
    }
    if (!moved) return;
    callable('callBriefDecide', Object.assign({}, who, { item: 'stage', decision: 'accept', value: plan.key, mode: mode, fromStage: from })).catch(function () { /* the move itself is saved */ });
    if (typeof onChange === 'function') { try { onChange(); } catch (_) { /* the card reloads itself */ } }
  }

  /**
   * A brief promise never goes to slot 0: that is promise-<callId>, the task
   * the card's Promise button writes and edits in place (review 2026-11-09).
   * It takes the lowest of slots 1-5 that no earlier Add used (any brief of
   * this call, from the decisions log), and the server refuses a slot that is
   * already taken, so a taken slot moves on to the next one.
   */
  function usedSlots() {
    var used = {};
    ((S && S.decisions) || []).forEach(function (d) { if (d && /^promise:/.test(d.item) && d.decision === 'accept' && d.slot >= 1) used[d.slot] = true; });
    Object.keys(S.slotUsed || {}).forEach(function (k) { used[k] = true; });
    return used;
  }
  async function addPromise(data) {
    S.slotUsed = S.slotUsed || {};
    for (var n = 1; n <= MAX_SLOT; n++) {
      if (usedSlots()[n]) continue;
      data.slot = n;
      try {
        var res = await callable('callCenterAction', Object.assign({}, data));
        S.slotUsed[n] = true;
        return res;
      } catch (e) {
        if (!/already on the customer/.test(errText(e))) throw e;
        S.slotUsed[n] = true;
      }
    }
    throw new Error('This call already has ' + MAX_SLOT + ' promises from briefs. Add another on the customer card.');
  }

  async function copyText(t) {
    try {
      var c = window.navigator && window.navigator.clipboard;
      if (!c || typeof c.writeText !== 'function') return false;
      await c.writeText(String(t || ''));
      return true;
    } catch (_) { return false; }
  }
  /**
   * One tap, through the CRM's existing path to a person's own phone / mail
   * app (phone-share.js): a text first asks the server whether this customer
   * may be texted now (STOP, Do Not Text, consent, switch, texting hours) and
   * then opens Messages with the words written; the person presses Send. Only
   * a send the person confirms is logged on the brief.
   */
  async function sendMessage(kind) {
    var draft = msgDraftNow();
    if (!draft) return;
    var lead = S.lead || {};
    var gate = kind === 'text' ? textConsent(lead) : emailOk(lead);
    S.msg.err = ''; S.msg.done = ''; S.msg.note = '';
    if (!gate.ok) { S.msg.err = gate.why; render(); return; }
    var ps = window.NBDPhoneShare;
    if (!ps || typeof ps.share !== 'function') { S.msg.err = 'Messages and Mail cannot be opened from this page. Copy the message instead.'; render(); return; }
    var words = kind === 'text' ? (S.msg.text != null ? S.msg.text : draft.text) : (S.msg.body != null ? S.msg.body : draft.body);
    // preferSms on both: in phone-share.js it means "skip the OS share sheet,
    // open the app directly", so the email path goes straight to mailto: with
    // the subject (a share sheet would drop it). No phone, so no text is sent.
    var opts = kind === 'text'
      ? { text: words, phone: lead.phone || lead.phoneDigits, leadId: S.leadId, preferSms: true, source: 'call_brief_followup' }
      : { text: words, email: String(lead.email || '').trim(), subject: S.msg.subject != null ? S.msg.subject : draft.subject, leadId: S.leadId, preferSms: true, source: 'call_brief_followup' };
    var mine = S;
    var r;
    try { r = await ps.share(opts); } catch (e) { r = { shared: false, reason: errText(e) }; }
    if (S !== mine) return;
    if (r && r.shared) {
      S.msg.done = kind === 'text' ? 'Sent from your phone.' : 'Sent from your mail app.';
      decide(kind === 'text' ? 'draft:followupText' : 'draft:followupEmail', 'accept', { value: String(words).slice(0, 600) }).catch(function () { /* it went; the log is best effort */ });
    } else if (r && (r.blocked || r.reason)) S.msg.err = r.reason || 'Not sent.';
    else S.msg.note = 'Not sent. The message is still here.';
    render();
  }

  function setWho(i, who) {
    var st = S && S.prom[i]; if (!st) return;
    st.who = who === 'them' ? 'them' : 'jo';
    st.kind = st.who === 'them' ? 'waiting' : (st.modelKind && st.modelKind !== 'waiting' ? st.modelKind : 'callback');
    render();
  }
  // The radiogroup keyboard pattern: arrow keys move the choice (two radios,
  // so any arrow flips it) and focus follows; Tab reaches only the checked one.
  function onKey(e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-cb-act="who"]') : null;
    if (!t || !S || ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].indexOf(e.key) === -1) return;
    e.preventDefault();
    var i = Number(t.getAttribute('data-i'));
    setWho(i, t.getAttribute('data-who') === 'them' ? 'jo' : 'them');
    var next = dlg.querySelector('[data-cb-act="who"][data-i="' + i + '"][aria-checked="true"]');
    if (next && typeof next.focus === 'function') next.focus();
  }

  async function followUp(undo) {
    var item = 'followUp';
    try {
      if (undo) {
        if (S.fuUndo && S.fuUndo.undo) await S.fuUndo.undo();
        S.fuUndo = null; delete S.done[item]; render(); changed(); return;
      }
      var ch = followUpChange(S.brief, S.lead);
      if (!ch || ch.retype) return;
      S.done[item] = 'busy'; render();
      if (!window.NBDFollowUpDeck && window.ScriptLoader && typeof window.ScriptLoader.load === 'function') await window.ScriptLoader.load(FOLLOWUP_JS);
      if (!window.NBDFollowUpDeck) throw new Error('Could not load the follow-up tools. Try again in a moment.');
      var lead = { id: S.leadId, followUp: S.lead ? S.lead.followUp : '' };
      var r = await window.NBDFollowUpDeck.setFollowUp(lead, ch.to);
      if (S.lead) S.lead.followUp = ch.to;
      S.fuUndo = { to: ch.to, undo: async function () { await r.undo(); if (S && S.lead) S.lead.followUp = lead.followUp; } };
      delete S.done[item];
      decide(item, 'accept', { value: ch.to }).catch(function () {});
      changed();
    } catch (e) { fail(item, e); }
    render();
  }

  async function draftProposal() {
    var brief = S.brief, lead = S.lead, leadId = S.leadId;
    var seed = projectSeed(brief, lead);
    var fromWhat = 'From the ' + src();
    var hints = scopeHints(brief, isVisit() ? 'at the walkthrough' : '');
    decide('draft:proposal', 'accept', { value: seed }).catch(function () {});
    close();
    try {
      if (!window.DocPreflight && window.ScriptLoader && typeof window.ScriptLoader.loadBundle === 'function') await window.ScriptLoader.loadBundle('docgen');
    } catch (_) { /* reported below */ }
    if (!window.DocPreflight || typeof window.DocPreflight.open !== 'function') {
      if (typeof window.showToast === 'function') window.showToast('Could not open the proposal. Try again in a moment.', 'error');
      return;
    }
    window.DocPreflight.open('proposal', leadId);
    // Seed only the Project Description (persist: LEAD → lead.scopeOfWork on
    // Generate), only when it is empty. Scope items are never seeded (they
    // persist to docOverrides); the call's scope is shown beside them.
    var tries = 0;
    (function seedWhenReady() {
      var ta = document.querySelector('[data-field="projectDescription"]');
      if (!ta) { if (++tries < 40) setTimeout(seedWhenReady, 100); return; }
      if (seed && !String(ta.value || '').trim()) {
        ta.value = seed;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }
      var wrap = document.querySelector('[data-field-wrap="scopeItems"]');
      if (wrap && hints.length && !wrap.querySelector('.cb-from-call')) {
        var box = document.createElement('div');
        box.className = 'cb-from-call';
        box.innerHTML = '<strong>' + esc(fromWhat) + '</strong> (copy what fits):<ul class="cb-list">' + hints.map(function (h) { return '<li>' + esc(h) + '</li>'; }).join('') + '</ul>';
        wrap.appendChild(box);
      }
    })();
  }

  /**
   * Start estimate (P1). The builder sets the call's choices only and saves
   * nothing by itself. On the dashboard (the builder, or its load-then-run
   * stub, is here) it opens over this page. On the customer page it goes to
   * the dashboard's ?lead= branch, which opens the builder for that customer;
   * the dashboard cleans its URL before the lazy builder loads, so the brief
   * this sheet got from the callBrief callable is handed over in
   * sessionStorage (estimate-v2-ui.js reads it once). The builder never reads
   * the stored brief itself, so the callable's kill switch covers both paths.
   */
  async function startEstimate() {
    var mine = S, leadId = S.leadId, callId = S.callId, brief = S.brief, onDashboard = S.page !== 'customer';
    if (!leadId || mine.estBusy) return;
    // The log first: callBriefDecide checks the call-brief kill switch, so a
    // brief shown before the switch went off opens nothing. Any other failure
    // (a network blip) does not block the rep; the log is best effort.
    mine.estBusy = true;
    try {
      await decide('draft:estimate', 'accept', { value: 'tapped Start estimate' });
    } catch (e) {
      if (/failed-precondition/.test(String((e && e.code) || ''))) {
        mine.estBusy = false;
        if (S === mine) { S.err = S.err || {}; S.err['draft:estimate'] = errText(e); render(); }
        return;
      }
    }
    if (S !== mine) return;   // the sheet was closed meanwhile
    close();
    if (onDashboard && typeof window.openEstimateV2Builder === 'function') {
      window.openEstimateV2Builder({ leadId: leadId, callPrefill: { callId: callId, brief: brief } });
      return;
    }
    try { window.sessionStorage.setItem('nbd.callBriefLink', JSON.stringify({ leadId: leadId, callId: callId, brief: brief, at: Date.now() })); } catch (_) { /* no hand-off: the builder opens without the call's choices */ }
    window.location.href = '/pro/dashboard.html?lead=' + encodeURIComponent(leadId) + '&callBrief=' + encodeURIComponent(callId);
  }

  // ── open / close ───────────────────────────────────────────────────────
  function ensureDialog() {
    if (window.ScriptLoader && typeof window.ScriptLoader.load === 'function') window.ScriptLoader.load(CSS_HREF);
    if (dlg && document.body.contains(dlg)) return dlg;
    dlg = document.createElement('dialog');
    dlg.className = 'cb-sheet';
    dlg.setAttribute('aria-labelledby', 'cbTitle');
    dlg.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('[data-cb-act]') : null;
      if (b && dlg.contains(b) && !b.disabled) { onAct(b); return; }
      if (e.target === dlg) close();   // a tap on the backdrop
    });
    dlg.addEventListener('keydown', onKey);
    dlg.addEventListener('input', onInput);
    dlg.addEventListener('change', onInput);
    dlg.addEventListener('close', function () { S = null; });
    document.body.appendChild(dlg);
    return dlg;
  }
  function onInput(e) {
    var t = e.target; if (!t || !S) return;
    var kind = t.getAttribute('data-cb-input');
    var i = Number(t.getAttribute('data-i'));
    if (kind === 'summary') S.summaryText = t.value;
    else if (kind === 'lostReason') S.lostReason = t.value;
    else if (kind === 'edit') S.edit['field:' + t.getAttribute('data-k')] = t.value;
    else if (kind === 'due' && S.prom[i]) S.prom[i].dueYmd = t.value;
    else if (kind === 'msg-text') S.msg.text = t.value;
    else if (kind === 'msg-subject') S.msg.subject = t.value;
    else if (kind === 'msg-body') S.msg.body = t.value;
    else if (kind === 'kind' && S.prom[i] && KINDS.indexOf(t.value) !== -1) {
      S.prom[i].kind = t.value;
      if (e.type === 'change') render();
    }
  }
  function show() {
    ensureDialog();
    render();
    if (!dlg.open) { if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', ''); }
  }
  // call-to-close-logic.js (the stage plan) loads with the sheet, never at boot.
  function loadLogic() {
    if (window.NBDCallToClose || !window.ScriptLoader || typeof window.ScriptLoader.load !== 'function') return Promise.resolve();
    return Promise.resolve(window.ScriptLoader.load(CTC_JS)).catch(function () { /* the stage card stays read-only */ });
  }
  function close() { if (dlg && dlg.open) { try { dlg.close(); } catch (_) { dlg.removeAttribute('open'); } } S = null; }

  /**
   * Open the sheet for one call. o: { callId, call, lead, leadId, page:
   * 'customer'|'calls', onChange }. Asks callBrief, then shows the answer.
   */
  async function open(o) {
    var x = o || {};
    if (!x.callId) return;
    S = { callId: x.callId, call: Object.assign({}, x.call || {}), lead: Object.assign({}, x.lead || {}), leadId: x.leadId || (x.call && x.call.leadId) || '',
      page: x.page === 'customer' ? 'customer' : 'calls', loading: true, error: '', done: {}, err: {}, edit: {}, confirm: '', prom: [], decisions: [], msg: {}, objCopied: {}, onChange: x.onChange };
    return fetchBrief();
  }

  /**
   * P2: open the sheet for one walkthrough. o: { visitId, visitUid, visit?
   * (startedAtMs, durationSec), lead?, leadId?, page?, onChange? }; lead,
   * leadId and page default to the customer page's (the timeline's button
   * passes only the ids, to keep the boot-loaded code small).
   */
  async function openVisit(o) {
    var x = o || {};
    if (!x.visitId || !x.visitUid) return;
    S = { callId: 'visit_' + x.visitId, visit: { visitId: String(x.visitId), visitUid: String(x.visitUid) }, call: Object.assign({}, x.visit || {}), lead: Object.assign({}, x.lead || window._leadDoc || {}), leadId: x.leadId || window._customerId || '',
      page: x.page === 'calls' ? 'calls' : 'customer', loading: true, error: '', done: {}, err: {}, edit: {}, confirm: '', prom: [], decisions: [], msg: {}, objCopied: {}, onChange: x.onChange };
    return fetchBrief();
  }

  async function fetchBrief() {
    var mine = S;
    show();
    var logic = loadLogic();
    try {
      var r = await callable('callBrief', ids());
      await logic;
      if (S !== mine) return;
      S.brief = r && r.brief; S.decisions = (r && r.decisions) || []; S.gen = r && r.generatedAtMs != null ? Number(r.generatedAtMs) : null; S.loading = false;
      if (!S.brief) S.error = 'The brief did not come back. Try again in a minute.';
      else initPromises();
    } catch (e) {
      if (S !== mine) return;
      S.loading = false; S.error = errText(e);
    }
    render();
  }

  /**
   * "Transcribe now" (P1, 2026-11-09): the cards' button. callTranscribeNow
   * runs this one stored call through the scheduled transcription pass now;
   * the sheet says what happened and the card reloads. o: as open().
   */
  async function transcribe(o) {
    var x = o || {};
    if (!x.callId) return;
    S = { mode: 'tx', callId: x.callId, call: Object.assign({}, x.call || {}), lead: Object.assign({}, x.lead || {}), leadId: x.leadId || '', page: x.page === 'customer' ? 'customer' : 'calls',
      loading: true, error: '', txMsg: '', done: {}, err: {}, edit: {}, confirm: '', prom: [], decisions: [], onChange: x.onChange };
    var mine = S;
    show();
    var r = null, err = null;
    // The SDK's 70 s default would call a long recording a failure while the
    // server is still transcribing it: wait as long as the function may run.
    try { r = await callable('callTranscribeNow', { callId: x.callId }, { timeout: 540000 }); } catch (e) { err = e; }
    // The card reloads even when the sheet was closed while it ran.
    if (r && /^(noted|already|personal)$/.test(r.state) && typeof x.onChange === 'function') { try { x.onChange(); } catch (_) { /* the card reloads itself */ } }
    if (S !== mine) return;
    S.loading = false;
    if (err) S.error = errText(err);
    else S.txMsg = (r && r.message) || 'Done.';
    render();
  }

  /** Show a brief already in hand (no server call): the screenshot walk and the tests. */
  function showWith(o) {
    var x = o || {};
    S = { callId: x.visit ? 'visit_' + x.visit.visitId : (x.callId || 'cube_PREVIEW'), visit: x.visit || null, call: x.call || {}, lead: x.lead || {}, leadId: x.leadId || '', page: x.page === 'customer' ? 'customer' : 'calls',
      loading: false, error: '', done: {}, err: {}, edit: {}, confirm: '', prom: [], msg: {}, objCopied: {}, decisions: x.decisions || [], gen: x.generatedAtMs != null ? Number(x.generatedAtMs) : null, brief: x.brief, onChange: null };
    initPromises();
    show();
    var mine = S;
    loadLogic().then(function () { if (S === mine) render(); });
    return dlg;
  }

  window.NBDCallBrief = {
    open: open, openVisit: openVisit, transcribe: transcribe, close: close, _showWith: showWith,
    _fieldRows: fieldRows, _followUpChange: followUpChange, _projectSeed: projectSeed, _scopeHints: scopeHints, _warnFor: warnFor,
    _followUpItems: msgItems, _followUpDraft: followUpDraft, _textConsent: textConsent, _emailOk: emailOk, _objectionTags: objectionTags, _whoDecides: whoDecides, PLAYBOOK: PLAYBOOK,
    _render: function () { render(); return dlg ? dlg.innerHTML : ''; },
    INSURANCE_WARN: INSURANCE_WARN, CALENDAR_WARN: CALENDAR_WARN, LEAD_FIELD_ALIASES: LEAD_FIELD_ALIASES,
  };
})();
