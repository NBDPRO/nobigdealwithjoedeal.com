/**
 * no-next-step.js — "No next step": open leads nobody is going to touch.
 *
 * The 2026-10-03 owner-tenant audit: 161 of 179 open leads had no follow-up
 * date AND no open task, and 102 of them hadn't been touched in 30+ days.
 * Nothing in the app surfaced them — Follow-ups Due only lists leads that
 * HAVE a date, Needs Attention only fires on stale stages / tasks /
 * estimates. This is the list of people with no next step at all, oldest
 * first, built so Jo can clear 100+ of them on an iPhone in one sitting:
 *
 *   - a Home card (#homeNoNextStep) with one-tap rows:
 *       Follow up in 3d / 1w / 2w   → followup-deck.js setFollowUp (the
 *                                      same `followUp` 'YYYY-MM-DD' write the
 *                                      card's date picker + Follow-ups deck do)
 *       Lost…                        → moveCard(id, 'lost') — the kanban's own
 *                                      stage path + lost-reason sheet
 *       Snooze 30d                   → LeadSnooze.snooze
 *     plus "Swipe through" (NBDTriageDeck, right = follow up in a week);
 *   - a "No next step" filter on the CRM board (NBDLeadFilters);
 *   - door-knock leads with no phone number grouped on their own (68 sat in
 *     "contacted" for 65+ days) with ONE confirm to bulk "mark lost — no
 *     contact info" (moveCard per lead with the reason supplied, the same
 *     per-lead stage path bulk Move uses, so each gets its stageHistory
 *     entry) or bulk snooze 30 days (LeadSnooze.bulkSnooze — the existing
 *     chunked writeBatch).
 *
 * Counts PEOPLE, not docs: leads are grouped by customerId → phone → email →
 * street address, and a person with ANY open lead that has a next step is
 * not listed. Excludes deleted, lost, won/closed and in-production leads,
 * and leads snoozed into the future (a snooze IS a next step).
 *
 * Nothing here sends anything to a customer. Writes are the rep's own lead
 * fields only, scoped to leads this user may change (own leads; staff: same
 * company), and every bulk write is behind a confirm naming the count.
 *
 * Pure logic is exported for tests (module.exports under Node); the browser
 * half reaches the page only through window.NBDNoNextStep.
 */
(function (root) {
  'use strict';

  // ── pure ─────────────────────────────────────────────────────────────
  var DAY = 86400000;
  var STALE_DAYS = 30;

  function toMs(t) {
    if (t == null || t === '') return 0;
    if (typeof t === 'number') return t;
    if (t instanceof Date) return t.getTime();
    if (typeof t.toMillis === 'function') return t.toMillis();
    if (typeof t.toDate === 'function') return t.toDate().getTime();
    if (typeof t.seconds === 'number') return t.seconds * 1000;
    var v = Date.parse(t); return isFinite(v) ? v : 0;
  }
  function digits10(p) { return String(p || '').replace(/\D/g, '').slice(-10); }

  function stageKeyOf(lead, normalize) {
    if (lead._stageKey) return lead._stageKey;
    if (typeof normalize === 'function') { try { return normalize(lead.stage) || lead.stage || 'new'; } catch (_) {} }
    return lead.stage || 'new';
  }

  /** Open = not deleted, not lost, not won/closed, not an in-production job. */
  function isOpenLead(lead, env) {
    if (!lead || !lead.id) return false;
    if (lead.deleted === true) return false;
    env = env || {};
    var sk = stageKeyOf(lead, env.normalizeStage);
    var role = lead._stageRole || (typeof env.stageRole === 'function' ? env.stageRole(sk) : null) || 'active';
    if (role === 'won' || role === 'lost' || role === 'job') return false;
    if (/^(closed|lost|complete|completed)$/i.test(String(sk)) || /^(closed|lost|complete|completed)$/i.test(String(lead.stage || ''))) return false;
    return true;
  }
  function hasFollowUp(lead) { return String(lead.followUp == null ? '' : lead.followUp).trim() !== ''; }
  function hasOpenTask(lead, taskCache) {
    var list = (taskCache && taskCache[lead.id]) || [];
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (t && !t.done && !t.completedAt && t.deleted !== true) return true;
    }
    return false;
  }
  function isSnoozed(lead, now) { return toMs(lead.snoozedUntil) > now; }
  function hasNextStep(lead, taskCache, now) {
    return hasFollowUp(lead) || hasOpenTask(lead, taskCache) || isSnoozed(lead, now);
  }

  /** Door-knock lead with no usable phone — same rule as crm-pipeline's. */
  function isUnreachableKnock(lead) {
    if (!lead) return false;
    var knock = !!lead.d2dKnockId || /door|d2d|knock|canvass/i.test(String(lead.source || ''));
    if (!knock) return false;
    return digits10(lead.phone || lead.phoneDigits).length < 10;
  }

  function personKey(lead) {
    if (lead.customerId) return 'c:' + lead.customerId;
    var d = digits10(lead.phone || lead.phoneDigits);
    if (d.length === 10) return 'p:' + d;
    var e = String(lead.email || '').trim().toLowerCase();
    if (e && e.indexOf('@') > 0) return 'e:' + e;
    var a = String(lead.address || '').split(',')[0].trim().toLowerCase().replace(/\s+/g, ' ');
    if (a.length >= 6) return 'a:' + a;
    return 'l:' + lead.id;
  }

  function lastTouchMs(lead) {
    return Math.max(toMs(lead.updatedAt), toMs(lead.stageStartedAt), toMs(lead.lastContactedAt), toMs(lead.createdAt));
  }
  function nameOf(lead) {
    var n = ((lead.firstName || '') + ' ' + (lead.lastName || '')).trim() || String(lead.name || '').trim();
    return n || String(lead.address || '').split(',')[0] || 'Customer';
  }

  /**
   * @param {Array} leads
   * @param {Object} taskCache  leadId → tasks[]
   * @param {Object} [env]      { now, stageRole, normalizeStage, canChange(lead) }
   * @returns {{people: Array, knockNoPhone: Array, total: number}}
   *   each person: { key, leadIds, lead (most recently touched), lastTouchMs,
   *   daysUntouched, name, knock }. Oldest (longest untouched) first.
   */
  function buildNoNextStep(leads, taskCache, env) {
    env = env || {};
    var now = env.now == null ? Date.now() : env.now;
    var groups = new Map();
    (leads || []).forEach(function (l) {
      if (!isOpenLead(l, env)) return;
      if (typeof env.canChange === 'function' && !env.canChange(l)) return;
      var k = personKey(l);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(l);
    });
    var people = [], knock = [];
    groups.forEach(function (arr, k) {
      for (var i = 0; i < arr.length; i++) if (hasNextStep(arr[i], taskCache, now)) return;
      var sorted = arr.slice().sort(function (a, b) { return lastTouchMs(b) - lastTouchMs(a); });
      var touch = lastTouchMs(sorted[0]);
      var p = {
        key: k,
        leadIds: sorted.map(function (l) { return l.id; }),
        lead: sorted[0],
        lastTouchMs: touch,
        daysUntouched: touch ? Math.max(0, Math.floor((now - touch) / DAY)) : null,
        name: nameOf(sorted[0]),
        knock: arr.every(isUnreachableKnock),
      };
      (p.knock ? knock : people).push(p);
    });
    var oldestFirst = function (a, b) { return (a.lastTouchMs || 0) - (b.lastTouchMs || 0); };
    people.sort(oldestFirst); knock.sort(oldestFirst);
    return { people: people, knockNoPhone: knock, total: people.length + knock.length };
  }

  /** 'YYYY-MM-DD' (local) n days from `now` — the followUp field's format. */
  function followUpIn(n, now) {
    var d = new Date(now == null ? Date.now() : now); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + n);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  var pure = {
    buildNoNextStep: buildNoNextStep, isOpenLead: isOpenLead, hasNextStep: hasNextStep,
    hasOpenTask: hasOpenTask, isUnreachableKnock: isUnreachableKnock, personKey: personKey,
    lastTouchMs: lastTouchMs, followUpIn: followUpIn, STALE_DAYS: STALE_DAYS,
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = pure; }
  if (!root || !root.document) return;

  // ── browser ──────────────────────────────────────────────────────────
  var w = root, doc = root.document;
  if (w.NBDNoNextStep) return;

  var FILTER = 'noNextStep';
  var KNOCK_REASON = 'No contact info (door knock, no phone)';
  var PAGE = 10;
  var shown = PAGE;
  var knockOpen = false;
  var busy = false;
  var tasksReady = false;
  var handled = new Set();          // person keys acted on this session (until data catches up)

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function toast(m, t) { if (typeof w.showToast === 'function') w.showToast(m, t || 'info'); }
  function claims() { return w._userClaims || {}; }
  function me() { return (w._user && w._user.uid) || null; }
  function isViewer() { return (claims().role || '') === 'viewer'; }
  // Same mutable-lead rule as commitBulkLeadOp (crm-portal-bridge.js).
  function canChange(l) {
    var c = claims(), role = c.role || '', uid = me();
    if (role === 'viewer') return false;
    if (role === 'admin' || !l.userId || !uid || l.userId === uid) return true;
    return (role === 'company_admin' || role === 'manager') && !!c.companyId && l.companyId === c.companyId;
  }
  function env() {
    return { stageRole: w.stageRole, normalizeStage: w.normalizeStage, canChange: canChange };
  }
  function compute() {
    var r = buildNoNextStep(w._leads || [], w._taskCache || {}, env());
    var keep = function (p) { return !handled.has(p.key); };
    return { people: r.people.filter(keep), knockNoPhone: r.knockNoPhone.filter(keep) };
  }
  function stageText(l) {
    var key = stageKeyOf(l, w.normalizeStage);
    if (typeof w.stageLabel === 'function') { try { var s = w.stageLabel(key); if (s) return s; } catch (_) {} }
    var M = w.STAGE_META || {};
    return (M[key] && M[key].label) || key;
  }
  function ageText(p) {
    if (p.daysUntouched == null) return 'never touched';
    if (p.daysUntouched === 0) return 'touched today';
    return 'untouched ' + p.daysUntouched + 'd';
  }
  function findPerson(key) {
    var r = compute();
    return r.people.concat(r.knockNoPhone).filter(function (p) { return p.key === key; })[0] || null;
  }

  function rowHtml(p) {
    var l = p.lead, addr = String(l.address || '').split(',')[0];
    var more = p.leadIds.length > 1 ? ' · ' + p.leadIds.length + ' leads' : '';
    return '<div class="nns-row" data-nns-key="' + esc(p.key) + '">' +
      '<div class="nns-main">' +
        '<a class="nns-name" href="/pro/customer.html?id=' + encodeURIComponent(l.id) + '">' + esc(p.name) + '</a>' +
        '<div class="nns-meta">' + esc(stageText(l)) + ' · <span class="' + (p.daysUntouched >= STALE_DAYS ? 'nns-old' : '') + '">' + esc(ageText(p)) + '</span>' + esc(more) + (addr && addr !== p.name ? ' · ' + esc(addr) : '') + '</div>' +
      '</div>' +
      '<div class="nns-acts" role="group" aria-label="Next step for ' + esc(p.name) + '">' +
        '<span class="nns-lbl">Follow up</span>' +
        '<button type="button" class="nns-btn nns-fu" data-nns-act="fu" data-nns-days="3" aria-label="Follow up in 3 days">3d</button>' +
        '<button type="button" class="nns-btn nns-fu" data-nns-act="fu" data-nns-days="7" aria-label="Follow up in 1 week">1w</button>' +
        '<button type="button" class="nns-btn nns-fu" data-nns-act="fu" data-nns-days="14" aria-label="Follow up in 2 weeks">2w</button>' +
        '<button type="button" class="nns-btn nns-lost" data-nns-act="lost">Lost…</button>' +
        '<button type="button" class="nns-btn" data-nns-act="snooze">Snooze 30d</button>' +
      '</div>' +
    '</div>';
  }

  function render() {
    var el = doc.getElementById('homeNoNextStep');
    paintFilterButton();
    if (!el) return;
    if (isViewer() || !tasksReady || !Array.isArray(w._leads)) { el.hidden = true; return; }
    var r = compute();
    var total = r.people.length + r.knockNoPhone.length;
    if (!total) { el.hidden = true; el.innerHTML = ''; return; }
    var stale = r.people.filter(function (p) { return p.daysUntouched >= STALE_DAYS; }).length;
    var html = '<div class="nns-head">' +
      '<div><div class="nns-title">No next step <span class="nns-count" id="nnsCount">' + total + '</span></div>' +
      '<div class="nns-sub">' + total + (total === 1 ? ' person has' : ' people have') + ' no follow-up and no open task' +
        (stale ? ' · ' + stale + ' untouched 30+ days' : '') + '. Oldest first.</div></div>' +
      '<div class="nns-head-acts">' +
        (r.people.length ? '<button type="button" class="nns-link" data-nns-act="deck">Swipe through</button>' : '') +
        '<button type="button" class="nns-link" data-nns-act="board">Show on board</button>' +
      '</div></div>';
    if (r.knockNoPhone.length) {
      var k = r.knockNoPhone.length;
      html += '<div class="nns-knock">' +
        '<div class="nns-knock-title">🚪 ' + k + ' door knock' + (k === 1 ? '' : 's') + ' with no phone number</div>' +
        '<div class="nns-sub">No way to follow up from the CRM. Clear them in one go — one confirm, nothing is sent to anyone.</div>' +
        '<div class="nns-knock-acts">' +
          '<button type="button" class="nns-btn nns-lost" data-nns-act="knock-lost">Mark all lost — no contact info</button>' +
          '<button type="button" class="nns-btn" data-nns-act="knock-snooze">Snooze all 30 days</button>' +
          '<button type="button" class="nns-link" data-nns-act="knock-toggle" aria-expanded="' + (knockOpen ? 'true' : 'false') + '">' + (knockOpen ? 'Hide list' : 'Show list') + '</button>' +
        '</div>' +
        (knockOpen ? '<div class="nns-list">' + r.knockNoPhone.map(rowHtml).join('') + '</div>' : '') +
      '</div>';
    }
    if (r.people.length) {
      html += '<div class="nns-list" id="nnsList">' + r.people.slice(0, shown).map(rowHtml).join('') + '</div>';
      if (r.people.length > shown) {
        html += '<button type="button" class="nns-more" data-nns-act="more">Show ' + Math.min(PAGE, r.people.length - shown) + ' more (' + (r.people.length - shown) + ' left)</button>';
      }
    }
    el.innerHTML = html;
    el.hidden = false;
  }

  var _t = null;
  function schedule() { if (_t) return; _t = setTimeout(function () { _t = null; try { render(); } catch (e) { console.warn('[no-next-step] render failed', e && e.message); } }, 200); }

  // ── writers (all existing) ───────────────────────────────────────────
  function leadById(id) { return (w._leads || []).filter(function (l) { return l && l.id === id; })[0] || null; }

  async function followUp(p, days) {
    var D = w.NBDFollowUpDeck;
    if (!D || typeof D.setFollowUp !== 'function') { toast('Follow-up tool not loaded — refresh and try again', 'error'); return false; }
    var val = followUpIn(days);
    var res = await D.setFollowUp(p.lead, val);
    handled.add(p.key);
    var when = new Date(val + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    if (typeof w.showToast === 'function') {
      w.showToast({
        message: 'Follow up with ' + p.name + ' ' + when,
        type: 'success', duration: 6000, undoText: 'Undo',
        undoAction: function () {
          Promise.resolve(res && res.undo && res.undo()).then(function () { handled.delete(p.key); refreshAll(); })
            .catch(function (e) { toast('Undo failed: ' + (e && e.message || 'unknown'), 'error'); });
        },
      });
    }
    return true;
  }

  async function markLost(p, reason) {
    if (typeof w.moveCard !== 'function') { toast('Pipeline not loaded — open the board once and try again', 'error'); return false; }
    var moved = 0, carry = reason || null;
    for (var i = 0; i < p.leadIds.length; i++) {
      var opts = carry ? { lostReason: carry } : undefined;
      var ok = await w.moveCard(p.leadIds[i], 'lost', opts);
      if (ok !== true) { if (!moved) return false; break; }
      moved++;
      var l = leadById(p.leadIds[i]);
      if (!carry && l && l.lostReason) carry = l.lostReason;
    }
    if (moved) handled.add(p.key);
    return moved > 0;
  }

  async function snooze30(p) {
    var S = w.LeadSnooze;
    if (!S || typeof S.snooze !== 'function') { toast('Snooze not loaded — refresh and try again', 'error'); return false; }
    var until = new Date(); until.setDate(until.getDate() + 30); until.setHours(9, 0, 0, 0);
    for (var i = 0; i < p.leadIds.length; i++) await S.snooze(p.leadIds[i], until, 'No next step');
    handled.add(p.key);
    toast('Snoozed ' + p.name + ' for 30 days', 'success');
    return true;
  }

  async function confirmIt(msg) {
    // No native confirm(): it is auto-cancelled in the installed iPhone app
    // (pwa-confirm-guard). Without the in-app dialog a bulk write is refused.
    if (typeof window.nbdConfirm === 'function') return !!(await window.nbdConfirm(msg));
    toast('Confirm dialog not loaded — refresh and try again', 'error');
    return false;
  }

  async function knockBulk(kind) {
    var list = compute().knockNoPhone;
    if (!list.length) return;
    var ids = [].concat.apply([], list.map(function (p) { return p.leadIds; }));
    var n = list.length;
    var msg = kind === 'lost'
      ? 'Mark ' + n + ' door-knock lead' + (n === 1 ? '' : 's') + ' with no phone number as Lost — "' + KNOCK_REASON + '"?\n\nEach moves to Lost through the normal stage change. Nothing is sent to anyone.'
      : 'Snooze ' + n + ' door-knock lead' + (n === 1 ? '' : 's') + ' with no phone number for 30 days?';
    if (!(await confirmIt(msg))) return;
    if (kind === 'snooze') {
      var S = w.LeadSnooze;
      if (!S || typeof S.bulkSnooze !== 'function') { toast('Snooze not loaded — refresh and try again', 'error'); return; }
      var until = new Date(); until.setDate(until.getDate() + 30); until.setHours(9, 0, 0, 0);
      await S.bulkSnooze(ids, until, 'No contact info');
      list.forEach(function (p) { handled.add(p.key); });
      return;
    }
    if (typeof w.moveCard !== 'function') { toast('Pipeline not loaded — open the board once and try again', 'error'); return; }
    toast('Marking ' + n + ' lost…', 'info');
    var done = 0, failed = 0;
    for (var i = 0; i < list.length; i++) {
      var p = list[i], okAll = true;
      for (var j = 0; j < p.leadIds.length; j++) {
        var ok = false;
        try { ok = (await w.moveCard(p.leadIds[j], 'lost', { lostReason: KNOCK_REASON })) === true; } catch (_) { ok = false; }
        if (!ok) okAll = false;
      }
      if (okAll) { done++; handled.add(p.key); } else failed++;
    }
    toast('Marked ' + done + ' lost' + (failed ? ' · ' + failed + ' not moved — open them to see why' : '') + '.', failed ? 'error' : 'success');
  }

  function openDeck() {
    var T = w.NBDTriageDeck;
    if (!T || typeof T.open !== 'function') { toast('Triage deck not loaded', 'error'); return; }
    var people = compute().people;
    T.open({
      id: 'no-next-step',
      title: 'No next step',
      items: people.map(function (p) { return { id: p.key, p: p }; }),
      card: function (it) {
        var p = it.p, l = p.lead, note = typeof l.notes === 'string' ? l.notes.trim().slice(0, 220) : '';
        return '<div class="deck-name">' + esc(p.name) + '</div>' +
          '<div><span class="deck-tag">' + esc(ageText(p)) + '</span></div>' +
          '<div class="deck-sub">' + esc(stageText(l)) + (l.address ? ' · ' + esc(String(l.address).split(',')[0]) : '') + '</div>' +
          (l.phone ? '<div class="deck-sub">' + esc(l.phone) + '</div>' : '') +
          (note ? '<div class="deck-why">' + esc(note) + '</div>' : '');
      },
      right: function (it) { return { label: 'Follow up in 1 week', act: function () { return followUp(it.p, 7); } }; },
      left: { label: 'Later' },
      more: function (it) {
        var d = digits10(it.p.lead.phone);
        return [].concat(
          d.length === 10 ? [{ label: '📞 Call', href: 'tel:' + d }, { label: '💬 Text', href: 'sms:' + d }] : [],
          [
            { label: 'Follow up in 3 days', act: function () { return followUp(it.p, 3); } },
            { label: 'Follow up in 2 weeks', act: function () { return followUp(it.p, 14); } },
            { label: 'Mark lost…', act: function () { return markLost(it.p); } },
            { label: 'Snooze 30 days', act: function () { return snooze30(it.p); } },
            { label: 'Open customer ↗', href: '/pro/customer.html?id=' + encodeURIComponent(it.p.lead.id) },
          ]
        );
      },
      doneText: 'Everyone has a next step.',
      onClose: function () { refreshAll(); },
    });
  }

  // ── board filter ─────────────────────────────────────────────────────
  function filterCompute() {
    var r = compute(), ids = new Set();
    r.people.concat(r.knockNoPhone).forEach(function (p) { p.leadIds.forEach(function (id) { ids.add(id); }); });
    return (w._leads || []).filter(function (l) { return l && ids.has(l.id); });
  }
  function paintFilterButton() {
    var btn = doc.getElementById('noNextStepBtn');
    if (!btn) return;
    var on = !!(w.NBDLeadFilters && w.NBDLeadFilters.isActive(FILTER));
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    var badge = doc.getElementById('noNextStepCountBadge');
    if (badge) {
      var r = tasksReady ? compute() : null;
      var c = r ? r.people.length + r.knockNoPhone.length : 0;
      badge.textContent = String(c);
      badge.hidden = !c;
    }
  }
  function toggleFilter() {
    if (!w.NBDLeadFilters) return;
    var on = w.NBDLeadFilters.toggle(FILTER);
    if (typeof w.syncMobileToolsMenuActive === 'function') { try { w.syncMobileToolsMenuActive(); } catch (_) {} }
    if (on && !filterCompute().length) toast('Every open lead has a next step.', 'success');
  }
  function showOnBoard() {
    var go = function () {
      if (w.NBDLeadFilters && !w.NBDLeadFilters.isActive(FILTER)) toggleFilter();
    };
    if (typeof w.goTo === 'function') { w.goTo('crm'); setTimeout(go, 400); } else go();
  }
  function refreshAll() {
    schedule();
    if (w.NBDLeadFilters && w.NBDLeadFilters.isActive(FILTER)) w.NBDLeadFilters.refresh();
  }

  // ── events ───────────────────────────────────────────────────────────
  doc.addEventListener('click', function (ev) {
    var t = ev.target && ev.target.closest && ev.target.closest('[data-nns-act]');
    if (!t) {
      var fb = ev.target && ev.target.closest && ev.target.closest('#noNextStepBtn');
      if (fb) { ev.preventDefault(); toggleFilter(); }
      return;
    }
    var act = t.getAttribute('data-nns-act');
    if (act === 'more') { shown += PAGE; render(); return; }
    if (act === 'knock-toggle') { knockOpen = !knockOpen; render(); return; }
    if (act === 'deck') { openDeck(); return; }
    if (act === 'board') { showOnBoard(); return; }
    if (busy) { toast('One moment — saving…', 'info'); return; }
    var run;
    if (act === 'knock-lost') run = function () { return knockBulk('lost'); };
    else if (act === 'knock-snooze') run = function () { return knockBulk('snooze'); };
    else {
      var row = t.closest('[data-nns-key]');
      var p = row && findPerson(row.getAttribute('data-nns-key'));
      if (!p) return;
      if (act === 'fu') run = function () { return followUp(p, parseInt(t.getAttribute('data-nns-days'), 10) || 7); };
      else if (act === 'lost') run = function () { return markLost(p); };
      else if (act === 'snooze') run = function () { return snooze30(p); };
      if (run && row) row.classList.add('nns-saving');
    }
    if (!run) return;
    busy = true;
    Promise.resolve().then(run).catch(function (e) {
      console.warn('[no-next-step] action failed', e);
      toast('Could not save: ' + (e && e.message || 'unknown error'), 'error');
    }).then(function () { busy = false; refreshAll(); });
  });

  function markTasksReady(e) {
    if (e && e.detail && e.detail.source === 'tasks') tasksReady = true;
    if (!tasksReady && w._taskCache && Object.keys(w._taskCache).length) tasksReady = true;
    // New data: anything the server now agrees on drops out of `handled`.
    if (handled.size) {
      var r = buildNoNextStep(w._leads || [], w._taskCache || {}, env());
      var still = new Set(r.people.concat(r.knockNoPhone).map(function (p) { return p.key; }));
      handled.forEach(function (k) { if (!still.has(k)) handled.delete(k); });
    }
    schedule();
  }
  w.addEventListener('nbd:data-refreshed', markTasksReady);
  w.addEventListener('hashchange', function () { setTimeout(schedule, 300); });

  function init() {
    if (w.NBDLeadFilters) w.NBDLeadFilters.register(FILTER, { compute: filterCompute, paint: paintFilterButton });
    markTasksReady();
    // Home is a <template> mounted on navigation: repaint when it appears.
    try {
      new MutationObserver(function () {
        var el = doc.getElementById('homeNoNextStep');
        if (el && !el.getAttribute('data-nns-mounted')) { el.setAttribute('data-nns-mounted', '1'); schedule(); }
      }).observe(doc.body, { childList: true, subtree: true });
    } catch (_) {}
    setInterval(function () { markTasksReady(); }, 60000);
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', function () { setTimeout(init, 1500); });
  else setTimeout(init, 1500);

  w.NBDNoNextStep = { compute: compute, render: render, toggleFilter: toggleFilter, _pure: pure };
})(typeof window !== 'undefined' ? window : this);
