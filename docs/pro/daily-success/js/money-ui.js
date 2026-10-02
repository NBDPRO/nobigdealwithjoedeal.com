/**
 * money-ui.js — the 💵 Money card + "Plan my paycheck" sheet (Jo's
 * operating system, Build 2, 2026-10-02). Rules: money-logic.js.
 *
 * Card (program dashboard, under the floor streak): emergency fund bar,
 * total card debt and the debt-free estimate, "Plan my paycheck".
 * Sheet: paycheck + frequency, bills, cards (nickname, balance, APR,
 * minimum), emergency fund, subscriptions (keep / cut), weekly spending
 * buffer, auto-saves — and the zero-based plan, recomputed as he types.
 * Stored in nbd_ds_money → userSettings.dsMoney (survives sign-out), where
 * the Finance Board's personal key reads it (my_money). Nicknames only:
 * a name with 6+ digits (an account number) is refused.
 *
 * Classic script after review-ui.js. Delegated listeners; every value that
 * reaches innerHTML is escaped.
 */
(function () {
  'use strict';
  if (window.NBDMoneyUI) return;
  const M = () => window.NBDMoney;
  const KEY = 'nbd_ds_money';
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = (m) => { if (typeof window.toast === 'function') window.toast(m); };
  const readJson = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (_) { return d; } };
  const dollars = (c) => (c ? (Math.round(c) / 100).toFixed(2).replace(/\.00$/, '') : '');

  let _draft = null;
  function load() { return M().normalize(readJson(KEY, {})); }
  function hasData(m) { return m.pay.amountCents > 0 || m.cards.length || m.bills.length; }

  // ── dashboard card ─────────────────────────────────────────────────────
  function cardHtml() {
    if (!M()) return '';
    const m = load();
    if (!hasData(m)) {
      return '<div class="wc-card mn-card" id="mnCard"><div class="wc-card-h">💵 Money</div>' +
        '<div class="wc-meta">Put in your paycheck, bills and cards once — every dollar gets a job, and you see your debt-free date.</div>' +
        '<button type="button" class="btn mn-start" data-mn-action="open">Plan my paycheck</button></div>';
    }
    const p = M().plan(m);
    const pay = p.debt.payoff;
    const fund = p.fund.targetCents ? '<div class="mn-bar"><i class="mn-fill" data-pct="' + Math.round((p.fund.pct || 0) * 100) + '"></i></div>' +
      '<div class="wc-meta">Emergency fund ' + esc(M().fmt(p.fund.balanceCents)) + ' of ' + esc(M().fmt(p.fund.targetCents)) + '</div>' : '';
    const debt = p.debt.totalCents ? '<div class="wc-meta">Cards ' + esc(M().fmt(p.debt.totalCents)) + ' · ' +
      (pay.capped ? 'not paid off at this pace' : 'debt-free in ~' + esc(pay.months) + ' month' + (pay.months === 1 ? '' : 's')) + '</div>' : '<div class="wc-meta">No card debt. 🔒</div>';
    const short = p.shortCents ? '<div class="wc-meta mn-short">Short ' + esc(M().fmt(p.shortCents)) + ' per paycheck — cut something.</div>' : '';
    return '<div class="wc-card mn-card" id="mnCard"><div class="wc-card-h">💵 Money</div>' + fund + debt + short +
      '<button type="button" class="btn btn-ghost mn-open" data-mn-action="open">Plan my paycheck</button></div>';
  }

  // ── sheet ──────────────────────────────────────────────────────────────
  function sheet() {
    let el = document.getElementById('mnOverlay');
    if (!el) { el = document.createElement('div'); el.id = 'mnOverlay'; el.className = 'wc-ov'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Money plan'); document.body.appendChild(el); }
    return el;
  }
  const money = (field, idx, val, ph) => '<input class="wc-in mn-in" inputmode="decimal" data-mn-field="' + field + '"' + (idx != null ? ' data-mn-i="' + idx + '"' : '') + ' value="' + esc(val) + '" placeholder="' + esc(ph || '0') + '">';
  const text = (field, idx, val, ph) => '<input class="wc-in mn-in mn-name" data-mn-field="' + field + '" data-mn-i="' + idx + '" maxlength="40" value="' + esc(val) + '" placeholder="' + esc(ph) + '">';
  const rm = (list, i) => '<button type="button" class="mn-x" data-mn-action="rm" data-mn-list="' + list + '" data-mn-i="' + i + '" aria-label="Remove">✕</button>';

  function formHtml(d) {
    const freqs = Object.keys(M().PERIODS).map((k) => '<option value="' + k + '"' + (d.pay.freq === k ? ' selected' : '') + '>' + esc(M().FREQ_LABEL[k]) + '</option>').join('');
    const rows = (list, f) => d[list].map(f).join('');
    return '<div class="wc-lbl">Paycheck (take-home)</div><div class="mn-row2">' + money('pay', null, dollars(d.pay.amountCents), '1500') +
      '<select class="wc-in mn-in" data-mn-field="freq">' + freqs + '</select></div>' +
      '<div class="wc-lbl">Bills <small>(monthly)</small></div>' + rows('bills', (b, i) => '<div class="mn-row">' + text('bills.name', i, b.name, 'Rent') + money('bills.monthly', i, dollars(b.monthlyCents)) + rm('bills', i) + '</div>') +
      '<button type="button" class="mn-add" data-mn-action="add" data-mn-list="bills">+ Bill</button>' +
      '<div class="wc-lbl">Credit cards <small>(nickname, balance, APR %, monthly minimum — never the card number)</small></div>' +
      rows('cards', (c, i) => '<div class="mn-card-row">' + text('cards.name', i, c.name, 'Chase Freedom') + rm('cards', i) +
        '<div class="mn-row3">' + money('cards.balance', i, dollars(c.balanceCents), 'Balance') +
        '<input class="wc-in mn-in" inputmode="decimal" data-mn-field="cards.apr" data-mn-i="' + i + '" value="' + esc(c.aprPct || '') + '" placeholder="APR %">' +
        money('cards.min', i, dollars(c.minCents), 'Minimum') + '</div></div>') +
      '<button type="button" class="mn-add" data-mn-action="add" data-mn-list="cards">+ Card</button>' +
      '<div class="wc-lbl">Emergency fund</div><div class="mn-row2">' + money('fund.balance', null, dollars(d.fund.balanceCents), 'Have now') + money('fund.target', null, dollars(d.fund.targetCents), 'Target') + '</div>' +
      '<div class="wc-lbl">Subscriptions <small>(monthly — tick to keep)</small></div>' + rows('subs', (s, i) => '<div class="mn-row"><label class="mn-keep"><input type="checkbox" data-mn-field="subs.keep" data-mn-i="' + i + '"' + (s.keep ? ' checked' : '') + '></label>' +
        text('subs.name', i, s.name, 'Netflix') + money('subs.monthly', i, dollars(s.monthlyCents)) + rm('subs', i) + '</div>') +
      '<button type="button" class="mn-add" data-mn-action="add" data-mn-list="subs">+ Subscription</button>' +
      '<div class="wc-lbl">Auto-saves <small>(monthly: Roth IRA, HSA…)</small></div>' + rows('saves', (s, i) => '<div class="mn-row">' + text('saves.name', i, s.name, 'Roth IRA') + money('saves.monthly', i, dollars(s.monthlyCents)) + rm('saves', i) + '</div>') +
      '<button type="button" class="mn-add" data-mn-action="add" data-mn-list="saves">+ Auto-save</button>' +
      '<div class="wc-lbl">Weekly spending buffer</div>' + money('buffer', null, dollars(d.bufferWeeklyCents), '75');
  }
  function planHtml(d) {
    const p = M().plan(d);
    if (!p.payCents) return '<div class="wc-meta">Put in your paycheck to see the plan.</div>';
    const lines = p.lines.map((l) => '<div class="rv-row mn-' + esc(l.kind) + '"><span>' + esc(l.label) + '</span><b>' + esc(M().fmt(l.cents)) + '</b></div>').join('');
    const pay = p.debt.payoff;
    return '<div class="wc-sum"><div><b>' + esc(M().fmt(p.payCents)) + '</b>' + esc(p.freqLabel) + '</div><div><b>' + (p.shortCents ? '−' + esc(M().fmt(p.shortCents)) : '$0') + '</b>left unassigned</div></div>' + lines +
      (p.shortCents ? '<div class="mn-short">Your fixed costs are ' + esc(M().fmt(p.shortCents)) + ' more than this paycheck. Cut a subscription or a bill before anything else.</div>' : '') +
      (p.debt.totalCents ? '<div class="wc-meta">Payoff order (highest APR first): ' + esc(p.debt.order.join(' → ')) + '. ' +
        (pay.capped ? 'At this pace the cards are never paid off — raise the payment.' : 'Debt-free in ~' + esc(pay.months) + ' months; ' + esc(M().fmt(pay.interestCents)) + ' in interest.') + '</div>' : '') +
      (p.fund.targetCents && p.fund.paychecksToTarget ? '<div class="wc-meta">Emergency fund full in ~' + esc(p.fund.paychecksToTarget) + ' paycheck' + (p.fund.paychecksToTarget === 1 ? '' : 's') + '.</div>' : '') +
      (p.cutSavedMonthlyCents ? '<div class="wc-meta">Cutting subscriptions frees ' + esc(M().fmt(p.cutSavedMonthlyCents)) + ' a month.</div>' : '') +
      '<div class="wc-hint">A pressure-test, not financial advice — check big moves (closing cards, retirement) with a professional.</div>';
  }
  function paintPlan() { const el = document.getElementById('mnPlan'); if (el && _draft) el.innerHTML = planHtml(_draft); }
  function paint() {
    const el = sheet();
    el.innerHTML = '<div class="wc-box"><div class="wc-top"><button class="wc-x" data-mn-action="close" aria-label="Close">✕</button>' +
      '<div class="wc-title">Plan my paycheck</div><span></span></div>' +
      '<div class="wc-hint">Every dollar gets a job: bills and minimums first, then the emergency fund, then extra on the highest-APR card.</div>' +
      '<div id="mnForm">' + formHtml(_draft) + '</div>' +
      '<div class="wc-lbl">Your plan</div><div id="mnPlan">' + planHtml(_draft) + '</div>' +
      '<div class="wc-foot"><button class="btn wc-finish" data-mn-action="save">Save</button><button class="btn btn-ghost" data-mn-action="close">Cancel</button></div></div>';
  }
  function open() { if (!M()) return; _draft = load(); paint(); const el = sheet(); el.classList.add('open'); document.body.classList.add('wc-lock'); }
  function close() { const el = document.getElementById('mnOverlay'); if (el) el.classList.remove('open'); document.body.classList.remove('wc-lock'); _draft = null; }

  function setField(field, i, el) {
    const d = _draft; if (!d) return;
    const v = el.type === 'checkbox' ? el.checked : el.value;
    const [list, prop] = field.split('.');
    if (field === 'pay') d.pay.amountCents = M().toCents(v);
    else if (field === 'freq') d.pay.freq = v;
    else if (field === 'buffer') d.bufferWeeklyCents = M().toCents(v);
    else if (list === 'fund') d.fund[prop === 'balance' ? 'balanceCents' : 'targetCents'] = M().toCents(v);
    else if (d[list] && d[list][i]) {
      const row = d[list][i];
      if (prop === 'name') {
        row.name = String(v).slice(0, 40);
        el.classList.toggle('mn-bad', M().badName(v));
        if (M().badName(v)) toast('Nickname only — never an account or card number');
      } else if (prop === 'monthly') row.monthlyCents = M().toCents(v);
      else if (prop === 'balance') row.balanceCents = M().toCents(v);
      else if (prop === 'min') row.minCents = M().toCents(v);
      else if (prop === 'apr') row.aprPct = Math.max(0, Math.min(99, parseFloat(v) || 0));
      else if (prop === 'keep') row.keep = !!v;
    }
    paintPlan();
  }
  function save() {
    if (!_draft) return;
    const raw = _draft;
    if (['bills', 'cards', 'subs', 'saves'].some((l) => raw[l].some((r) => M().badName(r.name)))) { toast('Remove the account / card number from a name first'); return; }
    const clean = M().normalize(raw);
    try { localStorage.setItem(KEY, JSON.stringify(clean)); } catch (_) { toast('Could not save on this device'); return; }
    if (typeof window.dsSettingsChanged === 'function') window.dsSettingsChanged(KEY);
    close();
    toast('Money plan saved');
    refresh();
    // Hand the Finance Board the new plan right away (review-ui publishes it in the snapshot).
    try { if (window.NBDReviewUI && typeof window.NBDReviewUI.publish === 'function') window.NBDReviewUI.publish(); } catch (_) {}
  }

  document.addEventListener('input', (ev) => { const t = ev.target; if (t && t.dataset && t.dataset.mnField && t.type !== 'checkbox') setField(t.dataset.mnField, Number(t.dataset.mnI), t); });
  document.addEventListener('change', (ev) => { const t = ev.target; if (t && t.dataset && t.dataset.mnField && (t.type === 'checkbox' || t.tagName === 'SELECT')) setField(t.dataset.mnField, Number(t.dataset.mnI), t); });
  document.addEventListener('click', (ev) => {
    const t = ev.target.closest && ev.target.closest('[data-mn-action]');
    if (!t) { if (ev.target && ev.target.id === 'mnOverlay') close(); return; }
    const a = t.dataset.mnAction;
    if (a === 'open') open();
    else if (a === 'close') close();
    else if (a === 'save') save();
    else if (a === 'add' && _draft) {
      const l = t.dataset.mnList;
      const blank = { bills: { name: '', monthlyCents: 0 }, cards: { name: '', balanceCents: 0, aprPct: 0, minCents: 0 }, subs: { name: '', monthlyCents: 0, keep: true }, saves: { name: '', monthlyCents: 0 } }[l];
      if (blank && _draft[l].length < 40) { _draft[l].push(blank); document.getElementById('mnForm').innerHTML = formHtml(_draft); }
    } else if (a === 'rm' && _draft) {
      const l = t.dataset.mnList, i = Number(t.dataset.mnI);
      if (_draft[l]) { _draft[l].splice(i, 1); document.getElementById('mnForm').innerHTML = formHtml(_draft); paintPlan(); }
    }
  });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && document.querySelector('#mnOverlay.open')) close(); });

  // ── hooks ──────────────────────────────────────────────────────────────
  function paintBars(root) { (root || document).querySelectorAll('.mn-fill[data-pct]').forEach((el) => { el.style.width = Math.max(0, Math.min(100, Number(el.dataset.pct) || 0)) + '%'; }); }
  function mountDash() {
    const main = document.getElementById('main');
    if (!main || document.getElementById('fit-pb') || document.getElementById('mnCard')) return;
    const box = document.createElement('div');
    box.className = 'mn-dash';
    box.innerHTML = cardHtml();
    const after = document.querySelector('.rv-dash');
    if (after && after.parentNode === main) main.insertBefore(box, after.nextSibling); else main.insertBefore(box, main.firstChild);
    paintBars(box);
  }
  function refresh() { const old = document.querySelector('.mn-dash'); if (old) old.remove(); try { mountDash(); } catch (_) {} }
  function hook() {
    const orig = window.renderDash;
    if (typeof orig === 'function' && !orig.__money) {
      const wrapped = function () { const r = orig.apply(this, arguments); try { mountDash(); } catch (_) {} return r; };
      Object.keys(orig).forEach((k) => { wrapped[k] = orig[k]; });
      wrapped.__money = true;
      window.renderDash = wrapped;
    }
  }
  function boot() {
    if (!M()) return;
    hook();
    try { if (typeof window.renderDash === 'function' && document.getElementById('main') && !document.getElementById('fit-pb')) mountDash(); } catch (_) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.NBDMoneyUI = { cardHtml, open, close, refresh };
})();
