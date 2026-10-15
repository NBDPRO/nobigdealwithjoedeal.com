/**
 * tests/visit-recorder-ui-2026-10-15.test.js - the visit recorder's SCREENS
 * (docs/pro/js/visit-recorder-ui.js), run for real in a vm sandbox with a small
 * fake DOM, a scripted NBDVisitRecorder core and the REAL logic module.
 *
 * Covers the 2026-10-15 reliability round, sheet by sheet:
 *   - every recovered recording is walked in order (only the first was handled)
 *   - the visit sheet's title follows the real state, and its detail refreshes
 *   - "Change customer" says why it failed; the attach toast says what was filed
 *   - Retry notes / Retry transcription say "check back in a minute"
 *   - the Unfiled sheet ignores upload-progress ticks, debounces, keeps an armed Discard
 *   - "Recent visits" shows attached visits that failed, in words
 *   - a visit from another device never has a blank badge
 *   - begin() re-reads a consent setting older than ten minutes
 *
 * Every absence check has a presence control in the same scenario.
 * Run: node tests/visit-recorder-ui-2026-10-15.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = {
  logic: fs.readFileSync(path.join(ROOT, 'docs/pro/js/visit-recorder-logic.js'), 'utf8'),
  ui: fs.readFileSync(process.env.VR_UI_PATH || path.join(ROOT, 'docs/pro/js/visit-recorder-ui.js'), 'utf8'),
};

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}
const J = (x) => JSON.stringify(x);
const tick = () => new Promise((r) => setImmediate(r));
async function settle() { for (let i = 0; i < 8; i++) await tick(); }

// ── a small DOM ────────────────────────────────────────────────────────────
function makeDom() {
  const docListeners = {};
  class El {
    constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.attrs = {}; this._text = ''; this.className = ''; this.listeners = {}; this.parent = null; this.dataset = {}; this.disabled = false; }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    set textContent(v) { this.children.forEach((c) => { c.parent = null; }); this.children = []; this._text = String(v); }
    get childNodes() { return this.children; }
    get isConnected() { let n = this; while (n.parent) n = n.parent; return n === body; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    appendChild(c) { if (c.parent) c.remove(); c.parent = this; this.children.push(c); return c; }
    remove() { if (this.parent) { this.parent.children = this.parent.children.filter((x) => x !== this); this.parent = null; } }
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
    click() { if (this.disabled) return; (this.listeners.click || []).forEach((fn) => fn({ target: this })); }
    focus() {}
    play() { return Promise.resolve(); }
    get classList() {
      const self = this;
      return { toggle(c, on) { const s = new Set(self.className.split(' ').filter(Boolean)); if (on) s.add(c); else s.delete(c); self.className = Array.from(s).join(' '); } };
    }
    walk(fn) { this.children.forEach((c) => { fn(c); c.walk(fn); }); }
    querySelector(sel) {
      let hit = null;
      this.walk((c) => { if (hit) return; if (sel === 'button' ? c.tagName === 'BUTTON' : (sel[0] === '.' && c.className.split(' ').indexOf(sel.slice(1)) !== -1)) hit = c; });
      return hit;
    }
  }
  const body = new El('body');
  const document = {
    body,
    createElement: (t) => new El(t),
    getElementById: (id) => { let hit = null; body.walk((c) => { if (!hit && c.attrs.id === id) hit = c; }); return hit; },
    addEventListener: (t, fn) => { (docListeners[t] = docListeners[t] || []).push(fn); },
    removeEventListener: (t, fn) => { docListeners[t] = (docListeners[t] || []).filter((f) => f !== fn); },
  };
  return { document, body, El, docListeners };
}

// ── a scripted core ────────────────────────────────────────────────────────
function makeCore(o) {
  o = o || {};
  const subs = [];
  const calls = { confirm: [], discard: [], attach: [], listAll: 0, retryNotes: 0, retryTranscription: 0, refreshConfig: 0, start: 0 };
  const R = {
    local: o.local || {}, server: o.server || {}, cfg: o.cfg || { consentMode: 'one_party', reminder: false, known: true, stale: false },
    getState: () => ({ active: null }),
    subscribe: (fn) => { subs.push(fn); return () => { const i = subs.indexOf(fn); if (i >= 0) subs.splice(i, 1); }; },
    emit: (k, d) => subs.slice().forEach((fn) => fn(k, d || {})),
    subsCount: () => subs.length,
    _getVisit: async (id) => (R.local[id] ? JSON.parse(J(R.local[id])) : undefined),
    getServerDoc: async (id) => (R.server[id] ? Object.assign({ id }, JSON.parse(J(R.server[id]))) : null),
    confirmRecovered: async (id) => { calls.confirm.push(id); return Object.assign({}, R.local[id] || { id, startedAtMs: 1 }, { needsRecoveryConfirm: false }); },
    discard: async (id) => { calls.discard.push(id); return { ok: true }; },
    attach: async (id, leadId) => { calls.attach.push([id, leadId]); return o.attach ? o.attach(id, leadId) : { ok: true, row: Object.assign({}, R.local[id] || { id }, { leadId }), server: { ok: true, filed: false } }; },
    listAll: async () => { calls.listAll++; return o.listAll ? o.listAll() : { local: Object.values(R.local), remote: Object.values(R.server) }; },
    retryNotes: async () => { calls.retryNotes++; return { ok: true, queued: true }; },
    retryTranscription: async () => { calls.retryTranscription++; return { ok: true, queued: true }; },
    retryNow: async () => {},
    dismissSuggestions: async () => ({ ok: true }),
    audioUrl: async () => ({ ok: true, url: 'https://storage.googleapis.com/b/a.m4a?sig' }),
    getConfig: () => R.cfg,
    refreshConfig: async () => { calls.refreshConfig++; return Object.assign({}, R.cfg, { stale: false }); },
    start: async () => { calls.start++; return { ok: false, reason: 'cancelled' }; },
    stop: async () => null, pause() {}, resume() {},
  };
  return { R, calls };
}

function boot(core, extra) {
  const dom = makeDom();
  const timers = [];
  const toasts = [];
  const sandbox = {
    console, Promise, JSON, Math, Object, Array, Number, String, Error, Date, Set,
    document: dom.document,
    navigator: { onLine: true },
    localStorage: { getItem: () => null, setItem() {} },
    setTimeout: (fn, ms) => { const t = { fn, ms, live: true, id: timers.length + 1 }; timers.push(t); return t.id; },
    clearTimeout: (id) => { const t = timers[id - 1]; if (t) t.live = false; },
    showToast: (m, tone) => toasts.push([m, tone]),
    _leads: (extra && extra.leads) || [{ id: 'L1', name: 'Ann Reyes' }, { id: 'L2', name: 'Bob Stone' }],
    NBDVisitRecorder: core.R,
  };
  sandbox.window = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(SRC.logic, ctx, { filename: 'visit-recorder-logic.js' });
  vm.runInContext(SRC.ui, ctx, { filename: 'visit-recorder-ui.js' });
  const UI = sandbox.NBDVisitRecorderUI;
  const scrim = () => { let s = null; dom.body.walk((c) => { if (!s && c.className === 'nbd-vr-scrim') s = c; }); return s; };
  const card = () => { const s = scrim(); return s && s.children[0]; };
  const title = () => { const c = card(); return c ? c.children[0].textContent : null; };
  const text = () => { const c = card(); return c ? c.textContent : ''; };
  const button = (label) => { const c = card(); let b = null; if (c) c.walk((n) => { if (!b && n.tagName === 'BUTTON' && n.textContent.indexOf(label) === 0) b = n; }); return b; };
  const buttons = (label) => { const c = card(); const out = []; if (c) c.walk((n) => { if (n.tagName === 'BUTTON' && n.textContent.indexOf(label) === 0) out.push(n); }); return out; };
  const fire = (pred) => { timers.filter((t) => t.live && (!pred || pred(t))).forEach((t) => { t.live = false; t.fn(); }); };
  return { UI, dom, timers, toasts, scrim, card, title, text, button, buttons, fire, sandbox };
}

(async function main() {
  const NOW = Date.now();
  console.log('VISIT RECORDER UI - recovery walks every recording');
  {
    const rows = ['r1', 'r2', 'r3'].map((id, i) => ({ id, startedAtMs: NOW - (3 - i) * 3600e3, durationSec: 60 * (i + 1), status: 'stored', needsRecoveryConfirm: true }));
    const core = makeCore({ local: Object.fromEntries(rows.map((r) => [r.id, r])) });
    const t = boot(core);
    t.UI.showRecovered([rows[2], rows[0], rows[1]]);   // out of order on purpose
    ok('three recovered: one sheet, oldest first, and it says two more come after', t.title() === 'Recovered recordings' && /2 more recovered recordings/.test(t.text()) && /1:00/.test(t.text()), t.text());
    t.UI.showRecovered([rows[1]]);   // the launcher asks again mid-walk
    ok('asking again mid-walk does not restart or duplicate it', /2 more/.test(t.text()));
    t.button('Save it').click(); await settle();
    ok('Save it on the first: it is confirmed and "Who was this?" opens for it', core.calls.confirm.join() === 'r1' && t.title() === 'Who was this?');
    t.button('Save unattached').click(); await settle();
    ok('...finishing that sheet goes on to the SECOND recovered recording (it used to stop here)', t.title() === 'Recovered recordings' && /1 more recovered recording comes/.test(t.text()) && /2:00/.test(t.text()), t.title() + ' | ' + t.text());
    t.button('Discard').click();
    ok('Discard needs a second tap (nothing deleted on the first)', core.calls.discard.length === 0 && !!t.button('Tap again to delete it'));
    t.button('Tap again to delete it').click(); await settle();
    ok('...the second tap deletes it and the THIRD comes up', core.calls.discard.join() === 'r2' && t.title() === 'Recovered a recording' && /3:00/.test(t.text()));
    t.button('Save it').click(); await settle();
    const s = t.scrim(); s.click(); await settle();   // tap outside the Who sheet
    ok('Save it, then dismissing the Who sheet ends the walk: every one was handled, in order', core.calls.confirm.join() === 'r1,r3' && core.calls.discard.join() === 'r2' && t.scrim() === null, J(core.calls));
    core.R.emit('recoverable', { rows: [{ id: 'r9', startedAtMs: NOW, durationSec: 5, status: 'stored' }] });
    ok('a recording the core finds later ("recoverable") is offered too', t.title() === 'Recovered a recording' && /0:05/.test(t.text()));
  }

  console.log('\nVISIT RECORDER UI - the visit sheet says where the visit really is');
  {
    const core = makeCore({
      local: { v1: { id: 'v1', leadId: 'L1', status: 'uploaded', docSynced: true, startedAtMs: NOW - 600e3 }, v2: { id: 'v2', leadId: 'L1', status: 'stored', startedAtMs: NOW } },
      server: { v1: { status: 'uploaded', pipelineStatus: 'transcribed', audioLive: true } },
    });
    const t = boot(core);
    t.UI.showWho(core.R.local.v2, '');
    await settle();
    ok('still on the phone: the title is "Saved on phone"', t.title() === 'Saved on phone', t.title());
    t.UI.showWho(core.R.local.v1, '');
    await settle();
    ok('uploaded and transcribed: the title says "Transcript saved" (it said "Saved on phone" whatever the state)', t.title() === 'Transcript saved', t.title());
    ok('...and the detail shows the server\'s words', /Transcript saved - writing notes/.test(t.text()), t.text());
    core.R.server.v1 = { status: 'uploaded', pipelineStatus: 'ready', audioLive: true, notes: { summary: 'Two layers, 28 squares.', promises: [] } };
    ok('a poll is armed while the server is still working', t.timers.some((x) => x.live && x.ms === 15000));
    t.fire((x) => x.ms === 15000); await settle();
    ok('when it fires, the sheet refreshes: "Notes ready", the summary, and the title follows', t.title() === 'Notes ready' && /Two layers, 28 squares/.test(t.text()) && /Notes ready/.test(t.text()), t.title() + ' | ' + t.text());
    ok('...and once it is settled it stops polling', !t.timers.some((x) => x.live && x.ms === 15000));
    t.button('Done').click();
    ok('closing the sheet unsubscribes everything it opened', core.R.subsCount() === 1, String(core.R.subsCount()));   // the UI's own 'recoverable' listener stays
  }
  {
    // Change customer: a failure is said, not swallowed
    const core = makeCore({
      local: { v1: { id: 'v1', leadId: 'L1', status: 'uploaded', docSynced: true, startedAtMs: NOW } },
      attach: (id, leadId) => (leadId === null ? { ok: false, message: 'Could not take the customer off right now.' } : { ok: true, row: { id, leadId } }),
    });
    const t = boot(core);
    t.UI.showWho(core.R.local.v1, ''); await settle();
    t.button('Change customer').click(); await settle();
    ok('Change customer fails: the sheet stays and says why (it failed silently)', t.title() !== null && /Could not take the customer off/.test(t.text()) && core.calls.attach.length === 1, t.text());
    const core2 = makeCore({ local: { v1: { id: 'v1', leadId: 'L1', status: 'uploaded', docSynced: true, startedAtMs: NOW } }, attach: (id) => ({ ok: true, row: { id, leadId: null, status: 'uploaded', startedAtMs: NOW } }) });
    const t2 = boot(core2);
    t2.UI.showWho(core2.R.local.v1, ''); await settle();
    t2.button('Change customer').click(); await settle();
    ok('CONTROL: when it works, the sheet asks "Who was this?" again', t2.title() === 'Who was this?');
  }
  {
    // the attach toast says what was filed, never "Nothing else was filed."
    const core = makeCore({
      local: { v3: { id: 'v3', leadId: null, status: 'uploaded', docSynced: true, startedAtMs: NOW } },
      server: { v3: { status: 'uploaded', pipelineStatus: 'transcribed', suggestions: [{ leadId: 'L2', name: 'Bob Stone', evidence: 'Matched by what was said.' }] } },
      attach: (id, leadId) => ({ ok: true, row: { id, leadId }, server: { ok: true, filed: false } }),
    });
    const t = boot(core);
    t.UI.showWho(core.R.local.v3, ''); await settle();
    const chip = (() => { let b = null; t.card().walk((n) => { if (!b && n.className === 'nbd-vr-chip' && /Bob Stone/.test(n.textContent)) b = n; }); return b; })();
    ok('setup: the server\'s suggestion is a chip', !!chip);
    chip.click(); await settle();
    const msg = (t.toasts[t.toasts.length - 1] || [''])[0];
    ok('attach toast: "when the notes are written", never "Nothing else was filed."', /Attached to Bob Stone/.test(msg) && /when the notes are written/.test(msg) && !/Nothing else/.test(msg), msg);
  }
  {
    // retries say "check back in a minute"; Retry transcription only where it can help
    const core = makeCore({
      local: { a: { id: 'a', leadId: 'L1', status: 'uploaded', docSynced: true, startedAtMs: NOW }, b: { id: 'b', leadId: 'L1', status: 'uploaded', docSynced: true, startedAtMs: NOW }, c: { id: 'c', leadId: 'L1', status: 'uploaded', docSynced: true, startedAtMs: NOW } },
      server: { a: { status: 'uploaded', pipelineStatus: 'notes_failed', audioLive: true }, b: { status: 'uploaded', pipelineStatus: 'failed', pipelineNote: 'transcribe_failed', audioLive: true }, c: { status: 'uploaded', pipelineStatus: 'failed', pipelineNote: 'too_large', audioLive: true } },
    });
    const t = boot(core);
    t.UI.showWho(core.R.local.a, ''); await settle();
    t.button('Retry notes').click(); await settle();
    ok('Retry notes: queued, and the button says "Retrying - check back in a minute"', core.calls.retryNotes === 1 && !!t.button('Retrying - check back in a minute'));
    t.UI.showWho(core.R.local.b, ''); await settle();
    ok('a failed visit whose audio is live: the words, a Retry transcription button, and Play audio', /Could not be processed: the transcriber could not read it/.test(t.text()) && !!t.button('Retry transcription') && !!t.button('Play audio') && t.title() === 'Could not be processed', t.text());
    t.button('Retry transcription').click(); await settle();
    ok('Retry transcription: queued, says check back', core.calls.retryTranscription === 1 && !!t.button('Retrying - check back in a minute'));
    t.UI.showWho(core.R.local.c, ''); await settle();
    ok('NEG: too large: no Retry transcription (it would not help), audio still playable, no raw code', !t.button('Retry transcription') && !!t.button('Play audio') && !/too_large/.test(t.text()) && /too big for the transcriber/.test(t.text()), t.text());
  }
  {
    // a visit from another device: never a blank badge
    const remote = { id: 'vR', remoteOnly: true, status: 'uploaded', pipelineStatus: 'ready', leadId: null, startedAtMs: NOW };
    const core = makeCore({ server: { vR: remote } });
    const t = boot(core);
    t.UI.showWho(remote, ''); await settle();
    const badge = (() => { let b = null; t.card().walk((n) => { if (!b && /nbd-vr-badge/.test(n.className)) b = n; }); return b; })();
    ok('another device\'s visit: the first badge has the server\'s words (it was blank)', badge && badge.textContent === 'Notes ready', badge && J(badge.textContent));
  }

  console.log('\nVISIT RECORDER UI - Unfiled visits + Recent visits');
  {
    const day = 86400e3;
    const core = makeCore({
      local: {
        u1: { id: 'u1', status: 'uploading', startedAtMs: NOW - 2 * day, durationSec: 30 },
        u2: { id: 'u2', status: 'stored', startedAtMs: NOW - 3 * day, durationSec: 40 },
        f1: { id: 'f1', status: 'uploaded', docSynced: true, leadId: 'L1', startedAtMs: NOW - day, durationSec: 50 },
      },
      server: { f1: { id: 'f1', status: 'uploaded', leadId: 'L1', pipelineStatus: 'failed', pipelineNote: 'too_large', audioLive: true, startedAtMs: NOW - day } },
    });
    const t = boot(core);
    t.UI.openUnfiled(); await settle();
    ok('opened: the lists are read once', core.calls.listAll === 1);
    ok('Unfiled lists the two unattached visits; "Other recent visits" lists the ATTACHED one that failed, in words', /Other recent visits \(last 14 days\)/.test(t.text()) && /Ann Reyes/.test(t.text()) && /Could not be processed: the recording is too big for the transcriber/.test(t.text()) && !/too_large/.test(t.text()), t.text());
    const items = () => { const out = []; t.card().walk((n) => { if (n.className === 'nbd-vr-item') out.push(n); }); return out; };
    ok('...each visit is listed once (the unfiled ones are not repeated below), one Attach per unfiled visit', items().length === 3 && t.buttons('Attach').length === 2 && t.buttons('Open').length === 1, String(items().length));
    for (let i = 0; i < 20; i++) core.R.emit('row', { row: { id: 'u1', status: 'uploading', progress: i * 5 }, progress: true });
    ok('20 upload-progress ticks: no re-read scheduled (it re-read both lists every ~400 ms)', !t.timers.some((x) => x.live && x.ms === 1200) && core.calls.listAll === 1);
    for (let i = 0; i < 5; i++) core.R.emit('row', { row: { id: 'u1', status: 'uploaded' } });
    ok('5 real status changes in a burst: ONE debounced re-read', t.timers.filter((x) => x.live && x.ms === 1200).length === 1);
    const discards = () => t.buttons('Discard');
    discards()[0].click();
    ok('setup: a Discard is armed', t.buttons('Tap again to delete').length === 1);
    core.R.local.u1 = Object.assign({}, core.R.local.u1, { status: 'uploaded', docSynced: true });   // something really changed
    t.fire((x) => x.ms === 1200); await settle();
    ok('...the re-read happened and rebuilt the list', core.calls.listAll === 2);
    ok('...and the armed Discard is STILL armed (a re-render used to reset it)', t.buttons('Tap again to delete').length === 1, J(t.buttons('Discard').map((b) => b.textContent)));
    t.buttons('Tap again to delete')[0].click(); await settle();
    ok('...so one more tap deletes it', core.calls.discard.length === 1);
    core.R.emit('counters', { unfiled: 1, pending: 0 });
    ok('a counters event does not re-read (listAll refreshes the counters: that would loop)', !t.timers.some((x) => x.live && x.ms === 1200));
    t.button('Close').click();
    core.R.emit('row', { row: { id: 'u2', status: 'uploaded' } });
    ok('closed: no more re-reads', !t.timers.some((x) => x.live && x.ms === 1200));
    t.UI.openRecent(); await settle();
    ok('openRecent: the Recent visits sheet on its own lists EVERY recent visit, attached or not', t.title() === 'Recent visits' && /Ann Reyes/.test(t.text()) && (() => { let n = 0; t.card().walk((x) => { if (x.className === 'nbd-vr-item') n++; }); return n === 3; })());
  }

  console.log('\nVISIT RECORDER UI - start and stop');
  {
    const core = makeCore({ cfg: { consentMode: 'one_party', reminder: false, known: true, stale: true } });
    const t = boot(core);
    await t.UI.begin({});
    ok('a known but STALE (over 10 min) consent setting is re-read before recording', core.calls.refreshConfig === 1 && core.calls.start === 1);
    const core2 = makeCore({ cfg: { consentMode: 'one_party', reminder: false, known: true, stale: false } });
    const t2 = boot(core2);
    await t2.UI.begin({});
    ok('CONTROL: a fresh one is not re-read (start is not delayed)', core2.calls.refreshConfig === 0 && core2.calls.start === 1);
  }
  {
    const core = makeCore({ local: { s1: { id: 's1', status: 'stored', startedAtMs: NOW } } });
    const t = boot(core);
    core.R.start = async () => ({ ok: true, id: 's1' });
    await t.UI.begin({});
    core.R.emit('stopped', { row: core.R.local.s1, reason: 'recorder-ended', notice: 'The microphone went silent.' });
    await settle();
    ok('stopped by a phone call: the sheet says it ended on its own and what was captured is saved', t.title() === 'Who was this?' && /phone call/.test(t.text()) && /saved/.test(t.text()), t.text());
    t.UI.close();
    await t.UI.begin({});   // the next recording (the panel listens again from its start)
    core.R.emit('stopped', { row: core.R.local.s1, reason: 'size-cap' });
    await settle();
    ok('stopped at the size limit: it says 24 MB and part 2', /24 MB/.test(t.text()) && /part 2/.test(t.text()));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
