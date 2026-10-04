/**
 * estimate-followups.js — estimates out 2, 5 and 10+ days, opened or not,
 * each with a pre-written follow-up Jo sends from his own phone (2026-10-03).
 *
 * WHY: 17 leads sat in estimate stages for a median 46 days; only 7 had a
 * follow-up date, and nothing in the CRM said "this estimate has been out a
 * week and they never opened it". (functions/lead-followup.js covers brand-
 * new web leads only and is deliberately untouched.)
 *
 * NOTHING SENDS AUTOMATICALLY. This computes a list. Each row's "Send" opens
 * the iPhone share sheet (phone-share.js) with the message already written;
 * only when Jo actually sends it is the lead stamped (lastEstimateNudgeAt),
 * which moves the row off the list until the next step of the cadence.
 *
 * PURE half (no DOM) — exported for the Today screen (branch feat/today-home)
 * and for tests:
 *   computeFollowups(leads, nowMs) → { rows, counts, total }
 *     rows: [{ leadId, name, firstName, phone, email, stage, sentAtMs,
 *              daysOut, bucket: 'd2'|'d5'|'d10', opened, openedAtMs,
 *              openedLabel, linkUrl, linkLive, message, lead }]
 *     counts: { d2:{opened,notOpened}, d5:{…}, d10:{…} }
 *   bucketFor(days) · isEstimateLead(lead) · sentAtMs(lead) · openedAtMs(lead)
 *   openedLabel(openedMs, nowMs) → "Opened 3h ago" | "Not opened yet"
 *   followupMessage({ firstName, from, url, bucket, opened })
 *   reviewMessage({ firstName, from, url })      (Send for review, item 1)
 *   fromLine(user, brandName)                    → "Joe with No Big Deal"
 *
 * DOM half: the Home card #homeEstimateFollowups (dashboard.html Home
 * template), rendered from window._leads on data refresh / Home entry.
 *
 * Copy rule: no claim-handling wording, ever (KY SB 153; tests/claim-wording
 * + tests/ky-claims-wording-scan). These messages talk about the estimate and
 * the roof, never about anyone's insurance.
 */
(function (root) {
  'use strict';

  const DAY = 86400000;
  const HOUR = 3600000;

  // Leads waiting on a decision about an estimate. The canonical keys
  // (docs/pro/js/crm-stages.js) plus the legacy display names a few old cards
  // still carry.
  const ESTIMATE_STAGES = ['estimate_submitted', 'estimate_sent_cash', 'service_quoted', 'negotiating',
    'estimate sent', 'estimate_sent', 'quote_sent', 'proposal_sent'];
  // Sold, building, done, lost — never chased about an estimate.
  const PAST_ESTIMATE = ['contract_signed', 'job_created', 'permit_pulled', 'materials_ordered',
    'materials_delivered', 'crew_scheduled', 'install_in_progress', 'install_complete', 'final_photos',
    'deductible_collected', 'final_payment', 'collections', 'closed', 'lost', 'warranty_claim',
    'warranty_scheduled', 'warranty_repaired', 'service_approved', 'loan_approved',
    'approved', 'in progress', 'complete', 'closed won', 'closed lost'];

  function toMs(t) {
    if (t == null || t === '') return 0;
    if (typeof t === 'number') return t;
    if (t instanceof Date) return t.getTime();
    if (typeof t.toMillis === 'function') return t.toMillis();
    if (typeof t.seconds === 'number') return t.seconds * 1000;
    const v = Date.parse(t); return Number.isFinite(v) ? v : 0;
  }
  const stageKey = (l) => String((l && (l.stage || l.status)) || '').trim().toLowerCase();

  function isClosedLead(l) {
    if (!l) return true;
    if (l.deleted === true || l.isDeleted === true || l.archived === true) return true;
    if (l.stageRole === 'won' || l.stageRole === 'lost') return true;
    return PAST_ESTIMATE.indexOf(stageKey(l)) !== -1;
  }

  /** In an estimate stage, or Jo sent an estimate and the card hasn't moved yet. */
  function isEstimateLead(l) {
    if (isClosedLead(l)) return false;
    if (ESTIMATE_STAGES.indexOf(stageKey(l)) !== -1) return true;
    return !!(l.sharedDocId && toMs(l.lastSharedAt));
  }

  /** When the estimate went out: the recorded share, else stage entry. */
  function sentAtMs(l) {
    if (!l) return 0;
    return toMs(l.lastSharedAt) || toMs(l.estimateSentAt) || toMs(l.stageStartedAt) || 0;
  }

  /** Latest homeowner open AFTER it went out (a stale open doesn't count). */
  function openedAtMs(l) {
    if (!l) return 0;
    const sent = sentAtMs(l);
    const m = Math.max(toMs(l.lastViewedAt), toMs(l.lastPortalOpenAt), toMs(l.viewedAt));
    return m && m >= sent - 60000 ? m : 0;
  }

  /** 2–4 days → d2, 5–9 → d5, 10+ → d10, under 2 → not yet. */
  function bucketFor(days) {
    const d = Math.floor(Number(days));
    if (!Number.isFinite(d) || d < 2) return null;
    if (d < 5) return 'd2';
    if (d < 10) return 'd5';
    return 'd10';
  }
  const BUCKET_RANK = { d2: 1, d5: 2, d10: 3 };

  /**
   * Due when no nudge has gone out at this step of the cadence. At 10+ days
   * a lead comes back weekly until it is won, lost or snoozed.
   */
  function isDue(l, nowMs) {
    const sent = sentAtMs(l);
    const b = bucketFor((nowMs - sent) / DAY);
    if (!b) return false;
    const nudge = toMs(l.lastEstimateNudgeAt);
    if (!nudge || nudge < sent) return true;
    const nb = bucketFor((nudge - sent) / DAY);
    if (!nb || BUCKET_RANK[nb] < BUCKET_RANK[b]) return true;
    return b === 'd10' && nowMs - nudge >= 7 * DAY;
  }

  function isSnoozed(l, nowMs) {
    if (toMs(l.snoozedUntil) > nowMs) return true;
    const f = typeof l.followUp === 'string' ? l.followUp.slice(0, 10) : '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(f)) {
      const today = new Date(nowMs).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      return f > today; // Jo already picked a day — respect it
    }
    return false;
  }

  function openedLabel(openedMs, nowMs) {
    if (!openedMs) return 'Not opened yet';
    const h = Math.max(0, Math.floor((nowMs - openedMs) / HOUR));
    if (h < 1) return 'Opened just now';
    if (h < 48) return 'Opened ' + h + 'h ago';
    return 'Opened ' + Math.floor(h / 24) + 'd ago';
  }

  function firstNameOf(l) {
    const f = String((l && l.firstName) || '').trim();
    if (f) return f.split(/\s+/)[0];
    const n = String((l && (l.name || l.customerName)) || '').trim();
    return n ? n.split(/\s+/)[0] : '';
  }
  function nameOf(l) {
    const n = ((l.firstName || '') + ' ' + (l.lastName || '')).trim();
    return n || String(l.name || l.address || 'Customer');
  }

  /** "Joe with No Big Deal" — who the text is from. */
  function fromLine(user, brandName) {
    const dn = String((user && user.displayName) || '').trim().split(/\s+/)[0];
    const brand = String(brandName || '').trim();
    if (dn && brand) return dn + ' with ' + brand;
    return dn || brand || '';
  }

  function _hi(first) { return 'Hi' + (first ? ' ' + first : '') + ','; }
  function _from(from) { return from ? ' it’s ' + from + '.' : ''; }

  /** The first send (customer page "Send for review"). */
  function reviewMessage(o) {
    const x = o || {};
    return _hi(x.firstName) + _from(x.from)
      + ' Here’s your roof estimate to look over:\n\n' + (x.url || '')
      + '\n\nTake your time, and text me with any questions.';
  }

  /** The cadence step's follow-up. `url` omitted when the link is dead. */
  function followupMessage(o) {
    const x = o || {};
    const link = x.url ? '\n\n' + x.url : '';
    const hi = _hi(x.firstName) + _from(x.from);
    if (x.bucket === 'd2') {
      return x.opened
        ? hi + ' Saw you had a chance to look at the estimate. Any questions I can answer?'
        : hi + ' Just making sure the estimate came through — here it is again:' + link;
    }
    if (x.bucket === 'd5') {
      return x.opened
        ? hi + ' Following up on the estimate. Happy to walk through the options or adjust anything — what would help?'
        : hi + ' Wanted to make sure the estimate didn’t get buried:' + link + '\n\nAny questions, just text me back.';
    }
    return hi + ' Checking in one more time on your roof estimate. No pressure at all — if the timing isn’t right, just let me know.' + link;
  }

  function linkLive(l, nowMs) {
    const url = typeof l.sharedLinkUrl === 'string' && /^https:\/\//.test(l.sharedLinkUrl) ? l.sharedLinkUrl : '';
    if (!url) return '';
    const exp = toMs(l.sharedLinkExpiresAt);
    return !exp || exp > nowMs + HOUR ? url : '';
  }

  function computeFollowups(leads, nowMs, opts) {
    const now = nowMs == null ? Date.now() : nowMs;
    const o = opts || {};
    const counts = { d2: { opened: 0, notOpened: 0 }, d5: { opened: 0, notOpened: 0 }, d10: { opened: 0, notOpened: 0 } };
    const rows = [];
    (leads || []).forEach((l) => {
      if (!l || !l.id || !isEstimateLead(l) || isSnoozed(l, now)) return;
      const sent = sentAtMs(l);
      if (!sent || sent > now) return;
      const daysOut = Math.floor((now - sent) / DAY);
      const bucket = bucketFor(daysOut);
      if (!bucket || !isDue(l, now)) return;
      const opened = openedAtMs(l);
      const url = linkLive(l, now);
      counts[bucket][opened ? 'opened' : 'notOpened']++;
      rows.push({
        leadId: l.id, name: nameOf(l), firstName: firstNameOf(l),
        phone: l.phone || '', email: l.email || '', stage: l.stage || '',
        sentAtMs: sent, daysOut, bucket, opened: !!opened, openedAtMs: opened,
        openedLabel: openedLabel(opened, now), linkUrl: url, linkLive: !!url,
        hasSharedDoc: !!l.sharedDocId,
        message: followupMessage({ firstName: firstNameOf(l), from: o.from || '', url, bucket, opened: !!opened }),
        lead: l,
      });
    });
    // Oldest bucket first; inside it, not-opened first (they need the nudge
    // most), then longest out.
    rows.sort((a, b) => (BUCKET_RANK[b.bucket] - BUCKET_RANK[a.bucket])
      || (Number(a.opened) - Number(b.opened)) || (b.daysOut - a.daysOut));
    return { rows, counts, total: rows.length };
  }

  const api = {
    ESTIMATE_STAGES, PAST_ESTIMATE, toMs, isEstimateLead, isClosedLead, sentAtMs, openedAtMs, bucketFor,
    isDue, isSnoozed, openedLabel, fromLine, reviewMessage, followupMessage, computeFollowups, linkLive,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (!root || !root.document) return;
  root.NBDEstimateFollowups = api;

  // ── DOM: the Home card ───────────────────────────────────────────────
  const w = root;
  const pending = Object.create(null); // leadId → { text } awaiting a "Share now" tap
  const BUCKET_LABEL = { d2: 'Out 2+ days', d5: 'Out 5+ days', d10: 'Out 10+ days' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }
  function brandName() {
    try { const b = typeof w._brand === 'function' ? w._brand() : null; return (b && (b.shortName || b.name)) || ''; } catch (_) { return ''; }
  }
  function currentFrom() { return fromLine(w._user, brandName()); }

  function hasOpenDeal(leadId) {
    try {
      const deals = w.CloseBoard && typeof w.CloseBoard.getDeals === 'function' ? w.CloseBoard.getDeals() : [];
      return (deals || []).some((d) => d && d.leadId === leadId && ['accepted', 'signed', 'scheduled'].indexOf(d.status) === -1);
    } catch (_) { return false; }
  }

  function rowHtml(r) {
    const p = pending[r.leadId];
    const send = p
      ? '<button type="button" class="btn btn-orange ef-btn" data-ef-share-now="' + esc(r.leadId) + '">📤 Share now</button>'
      : '<button type="button" class="btn btn-orange ef-btn" data-ef-send="' + esc(r.leadId) + '">📤 Follow up</button>';
    // Fresh link only where there IS a link to replace: a PDF sent for
    // review, or an open Close Board deal for this lead.
    const fresh = (r.hasSharedDoc || hasOpenDeal(r.leadId))
      ? '<button type="button" class="btn btn-ghost ef-btn" data-ef-fresh="' + esc(r.leadId) + '" title="New link; the old one stops working">↻ Fresh link</button>'
      : '';
    const expired = !r.linkLive && r.lead && typeof r.lead.sharedLinkUrl === 'string' && r.lead.sharedLinkUrl;
    return '<div class="ef-row" data-lead-id="' + esc(r.leadId) + '">'
      + '<div class="ef-who"><a class="ef-name" href="/pro/customer.html?id=' + encodeURIComponent(r.leadId) + '">' + esc(r.name) + '</a>'
      + '<div class="ef-meta">Sent ' + r.daysOut + 'd ago · <span class="' + (r.opened ? 'ef-opened' : 'ef-unopened') + '">' + esc(r.openedLabel) + '</span>'
      + (expired ? ' · link expired' : '') + '</div></div>'
      + '<div class="ef-acts">' + send + fresh + '</div></div>';
  }

  function cardHtml(res) {
    if (!res.total) return '';
    let html = '<div class="ef-card panel"><div class="panel-hdr"><div><div class="panel-label">Nothing sends by itself — you tap, it goes from your phone</div>'
      + '<div class="panel-title">📨 Estimate follow-ups (' + res.total + ')</div></div></div><div class="panel-body">';
    ['d10', 'd5', 'd2'].forEach((b) => {
      const inB = res.rows.filter((r) => r.bucket === b);
      if (!inB.length) return;
      const c = res.counts[b];
      html += '<div class="ef-bucket"><div class="ef-bucket-hdr">' + BUCKET_LABEL[b]
        + ' <span class="ef-split">' + c.notOpened + ' not opened · ' + c.opened + ' opened</span></div>'
        + inB.map(rowHtml).join('') + '</div>';
    });
    return html + '</div></div>';
  }

  let _last = null;
  function render() {
    const el = document.getElementById('homeEstimateFollowups');
    if (!el) return null;
    const res = computeFollowups(Array.isArray(w._leads) ? w._leads : [], Date.now(), { from: currentFrom() });
    _last = res;
    const html = cardHtml(res);
    el.innerHTML = html;
    el.hidden = !html;
    return res;
  }

  function findRow(leadId) { return _last && _last.rows.find((r) => r.leadId === leadId); }
  function toast(m, t) { if (typeof w.showToast === 'function') w.showToast(m, t || 'info'); }

  function patchLead(leadId, patch) {
    if (Array.isArray(w._leads)) {
      const i = w._leads.findIndex((l) => l && l.id === leadId);
      if (i >= 0) w._leads[i] = Object.assign({}, w._leads[i], patch);
    }
  }

  async function stampNudge(leadId, via) {
    const now = new Date();
    const lead = (Array.isArray(w._leads) ? w._leads.find((l) => l && l.id === leadId) : null) || {};
    patchLead(leadId, { lastEstimateNudgeAt: now, estimateNudgeCount: (Number(lead.estimateNudgeCount) || 0) + 1 });
    render();
    try {
      if (w.db && w.doc && w.updateDoc) {
        await w.updateDoc(w.doc(w.db, 'leads', leadId), {
          lastEstimateNudgeAt: w.serverTimestamp ? w.serverTimestamp() : now,
          lastEstimateNudgeVia: via || 'phone_share',
          estimateNudgeCount: (Number(lead.estimateNudgeCount) || 0) + 1,
        });
      }
    } catch (e) { console.warn('[estimate-followups] nudge stamp failed', e && e.message); }
  }

  async function shareFor(leadId, text, opts) {
    const r = findRow(leadId) || {};
    const res = await w.NBDPhoneShare.share(Object.assign({
      text, phone: r.phone, email: r.email, subject: 'Your roof estimate', title: 'Roof estimate',
    }, opts || {}));
    if (res.needsTap) {
      pending[leadId] = { text };
      render();
      toast('Link ready — tap “Share now” to send it', 'info');
      return res;
    }
    delete pending[leadId];
    if (res.shared) {
      await stampNudge(leadId, res.via === 'share' ? 'phone_share' : res.via);
      toast('Shared from your phone ✓', 'success');
    } else {
      render();
    }
    return res;
  }

  async function callable(name, data) {
    if (!w._functions || !w._httpsCallable) {
      const mod = await import('/assets/vendor/firebase/10.12.2/firebase-functions.js');
      w._functions = w._functions || mod.getFunctions();
      try {
        const emu = await import('./nbd-emulator-connect.js');
        await emu.connectEmulatorsIfLocal({ functions: w._functions });
      } catch (_) { /* prod: no emulator module needed */ }
      w._httpsCallable = w._httpsCallable || mod.httpsCallable;
    }
    const res = await w._httpsCallable(w._functions, name)(data);
    return (res && res.data) || {};
  }

  async function freshLink(leadId, btn) {
    if (w.NBDRole && typeof w.NBDRole.guard === 'function' && !w.NBDRole.guard()) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Linking…'; }
    try {
      const out = await callable('freshEstimateLink', { leadId });
      if (!out.url) throw new Error('No link came back');
      const patch = { sharedLinkUrl: out.url, sharedLinkExpiresAt: out.expiresAt || null };
      patchLead(leadId, patch);
      const r = findRow(leadId) || {};
      const text = followupMessage({ firstName: r.firstName, from: currentFrom(), url: out.url, bucket: r.bucket || 'd5', opened: !!r.opened });
      const res = await shareFor(leadId, text);
      if (res.shared && out.kind === 'review' && out.token && out.documentId) {
        callable('recordEstimateShared', { leadId, documentId: out.documentId, token: out.token, via: res.via === 'share' ? 'phone_share' : res.via })
          .catch((e) => console.warn('[estimate-followups] record share failed', e && e.message));
      }
    } catch (e) {
      toast('Could not make a fresh link: ' + ((e && e.message) || 'unknown'), 'error');
    } finally {
      if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = '↻ Fresh link'; }
    }
  }

  document.addEventListener('click', (ev) => {
    const t = ev.target && ev.target.closest ? ev.target.closest('[data-ef-send],[data-ef-share-now],[data-ef-fresh]') : null;
    if (!t) return;
    ev.preventDefault();
    if (t.hasAttribute('data-ef-fresh')) { freshLink(t.getAttribute('data-ef-fresh'), t); return; }
    if (w.NBDRole && typeof w.NBDRole.guard === 'function' && !w.NBDRole.guard()) return;
    if (!w.NBDPhoneShare) { toast('Sharing is still loading — try again', 'error'); return; }
    const id = t.getAttribute('data-ef-share-now') || t.getAttribute('data-ef-send');
    const p = pending[id];
    const r = findRow(id);
    const text = p ? p.text : (r && r.message);
    if (!text) return;
    shareFor(id, text, p ? { noRetry: true } : null);
  });

  w.addEventListener('nbd:data-refreshed', () => { render(); });
  w.addEventListener('hashchange', () => { if (/^#?\/?(home|dash)?$/.test(location.hash || '')) setTimeout(render, 300); });
  const boot = () => setTimeout(render, 1500);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  api.render = render;
})(typeof window !== 'undefined' ? window : null);
