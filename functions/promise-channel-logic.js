'use strict';
/**
 * promise-channel-logic.js - the SERVER channel for dated promises and Waiting
 * items that live only as lead tasks (2026-10-13; audit F1,
 * documentation/audit/NEEDS-YOU-LIFECYCLE-AND-VOLUME-2026-10-13.md).
 *
 * The Handled sheet closes the call and puts the debt on a task
 * (leads/{id}/tasks/promise-<callId>, kind 'promise'); until now nothing on the
 * server read a task's date, so the due day had no push, no rung, no brief
 * line, no sweep line and no ledger count. This module is the pure half of the
 * fix: raw task docs in, PEOPLE out, one row per person however many items they
 * are owed. functions/promise-channel.js does the reads.
 *
 * Rules (each pinned by tests/promise-channel-2026-10-13.test.js):
 *   - owed  = an open kind:'promise' task, not Waiting, dated today or earlier
 *   - ripe  = an open Waiting item whose nudge date has come
 *   - done / kept / dead / deleted tasks never appear; a moved date is simply
 *     re-evaluated (a date ahead is "parked": call-watch-logic.parkedUntil, the
 *     same single rule every other surface uses)
 *   - count PEOPLE (key 'lead:<id>', the same key callerKey gives a filed call),
 *     so a person with three due items, or with a due task AND an open call, is
 *     one row, one push line, one ledger person
 *   - labels: a promise is Jo's word, so hide / quiet never drop it; a number
 *     Jo labelled SPAM does ("spam doesn't"); a hidden personal number's
 *     promise breaks through
 *   - tenant: only leads of the owner's tenant; a deleted lead's tasks are off
 */
const PR = require('./promise-logic');
const W = require('./call-watch-logic');

const WHY_SHOW = 90;
const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

/** Open promise / ripe-Waiting items from raw task docs ({ id, leadId, ...fields }). */
function dueItems(tasks, now) {
  const today = W.etYmd(now == null ? Date.now() : now);
  const out = [];
  (tasks || []).forEach((t) => {
    if (!t || !t.leadId || !PR.isPromise(t) || !PR.isOpen(t)) return;
    // The one parked rule: a date ahead is not due yet.
    if (W.parkedUntil(Object.assign({}, t, { kind: 'promise' }), now)) return;
    const waiting = PR.isWaiting(t);
    if (!(waiting ? PR.isRipe(t, today, PR.DEFAULT_WAITING_DAYS) : PR.isOwedNow(t, today))) return;
    out.push({
      taskId: String(t.id || ''), leadId: String(t.leadId), kind: t.promiseKind, waiting,
      text: clip(t.text || t.title || (waiting ? 'Waiting' : 'Promise'), 140),
      due: PR.dueYmdOf(t) || today, miss: Number(t.missCount) || 0,
    });
  });
  return out;
}

const digits10 = (v) => String(v == null ? '' : v).replace(/\D/g, '').slice(-10);
function labelFor(labels, lead) {
  if (!labels || !lead) return null;
  const d = digits10(lead.phoneDigits || lead.phone);
  if (d.length !== 10) return null;
  return (typeof labels.get === 'function' ? labels.get(d) : labels[d]) || null;
}
const leadName = (l) => clip(((l.firstName || '') + ' ' + (l.lastName || '')).trim() || l.name || l.fullName || l.address || 'Customer', 60);

/**
 * People owed something: [{ key, leadId, who, items[], dueYmd, overdue, waitingOnly, atMs }].
 * leadsById: Map / object of lead docs the caller could read ({ id? ...fields }).
 */
function duePeople(tasks, leadsById, opts) {
  const o = opts || {};
  const now = o.now == null ? Date.now() : o.now;
  const today = W.etYmd(now);
  const get = (id) => (leadsById && typeof leadsById.get === 'function' ? leadsById.get(id) : (leadsById || {})[id]);
  const by = new Map();
  dueItems(tasks, now).forEach((it) => {
    const lead = get(it.leadId);
    if (!lead || lead.deleted === true) return;
    if (o.owner && lead.userId !== o.owner && lead.companyId !== o.owner) return;
    const lb = labelFor(o.labels, lead);
    if (lb && lb.kind === 'spam') return;            // spam never surfaces, even with a promise
    if (!by.has(it.leadId)) by.set(it.leadId, { key: 'lead:' + it.leadId, leadId: it.leadId, who: leadName(lead), items: [] });
    by.get(it.leadId).items.push(it);
  });
  const people = Array.from(by.values()).map((p) => {
    p.items.sort((a, b) => String(a.due).localeCompare(String(b.due)) || a.taskId.localeCompare(b.taskId));
    p.dueYmd = p.items[0].due;
    p.overdue = p.dueYmd < today;
    p.waitingOnly = p.items.every((i) => i.waiting);
    p.atMs = Date.parse(p.dueYmd + 'T12:00:00Z') || now;
    return p;
  });
  return people.sort((a, b) => String(a.dueYmd).localeCompare(String(b.dueYmd)) || a.who.localeCompare(b.who));
}

/** The ladder candidate for a person: one id per PERSON, a signature of what is due. */
function ladderExtra(p) {
  const first = p.items[0];
  const more = p.items.length > 1 ? ' (+' + (p.items.length - 1) + ' more)' : '';
  return {
    id: 'promise:' + p.leadId, key: p.key, kind: 'promise', who: p.who,
    why: (p.waitingOnly ? 'follow-up due' : 'you promised something') + ' - ' + clip(first.text, WHY_SHOW) + more,
    at: p.atMs, sig: p.items.map((i) => i.taskId + ':' + i.due).sort().join('|'),
  };
}

/** The ONE morning push: 'N promises due today' (N = people). */
function pushText(people) {
  const n = people.length;
  const body = people.slice(0, 2).map((p) => p.who + ' - ' + clip(p.items[0].text, 70) + (p.items.length > 1 ? ' (+' + (p.items.length - 1) + ')' : '')).join('; ') + (n > 2 ? ' +' + (n - 2) + ' more' : '');
  return { title: n + (n === 1 ? ' promise' : ' promises') + ' due today', body, bell: people.slice(0, 8).map((p) => '- ' + p.who + ': ' + p.items.map((i) => clip(i.text, 70)).join('; ')).join('\n') };
}

/** Sweep / brief rows (call-center-logic.collectSweepItems shape, kind 'promise'). */
function sweepItems(people) {
  return (people || []).map((p) => ({
    callId: 'promise:' + p.leadId, channel: 'call', leadId: p.leadId, who: p.who, startedAtMs: p.atMs, summary: '',
    promises: Array.from(new Set(p.items.map((i) => i.text))), phoneDigits: '', hasTask: true, contactName: p.who, callType: '',
    kind: 'promise', due: p.dueYmd,
  }));
}

/** Fold promise rows into the call-based sweep items, one row per PERSON. */
function mergeSweep(items, people) {
  const out = (items || []).slice();
  sweepItems(people).forEach((row) => {
    const host = out.find((i) => i.leadId && i.leadId === row.leadId);
    if (host) { row.promises.forEach((t) => { if (!host.promises.includes(t)) host.promises.push(t); }); return; }
    out.push(row);
  });
  const rank = { urgent: 0, due: 1, promise: 1, nofile: 2 };
  return out.sort((a, b) => (rank[a.kind] - rank[b.kind]) || String(a.due).localeCompare(String(b.due)) || (a.startedAtMs || 0) - (b.startedAtMs || 0));
}

module.exports = { dueItems, duePeople, ladderExtra, pushText, sweepItems, mergeSweep, digits10 };
