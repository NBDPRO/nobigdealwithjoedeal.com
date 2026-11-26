/**
 * storm-tips.js — the /pro/storm-tips owner screen (2026-11-26).
 *
 * Talks only to the stormTipsAdmin callable (functions/storm-tips-email.js),
 * which enforces every rule: NBD owner only, the env flag, the messaging kill
 * switch and canary, the unsubscribe register, first contact = 'first-hello',
 * one email per person per 14 days. This page just shows the state and asks.
 * Every value from the server goes into the DOM with textContent.
 */
import { initializeApp, getApps } from "/assets/vendor/firebase/10.12.2/firebase-app.js";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "/assets/vendor/firebase/10.12.2/firebase-app-check.js";
import { getAuth, onAuthStateChanged } from "/assets/vendor/firebase/10.12.2/firebase-auth.js";
import { getFunctions, httpsCallable } from "/assets/vendor/firebase/10.12.2/firebase-functions.js";
import { connectEmulatorsIfLocal } from "../nbd-emulator-connect.js";

// Canonical config (mirrors nbd-auth.js).
const firebaseConfig = {
  apiKey: "AIzaSyDTrotINzl2YjdGbH25BpC-FPv8i_fXNvg",
  authDomain: "nobigdeal-pro.firebaseapp.com",
  projectId: "nobigdeal-pro",
  storageBucket: "nobigdeal-pro.firebasestorage.app",
  messagingSenderId: "717435841570",
  appId: "1:717435841570:web:c2338e11052c96fde02e7b"
};
const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
try {
  if (typeof window.__NBD_APP_CHECK_KEY === 'string' && window.__NBD_APP_CHECK_KEY) {
    initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(window.__NBD_APP_CHECK_KEY),
      isTokenAutoRefreshEnabled: true,
    });
  }
} catch (_) {}

const auth = getAuth(app);
const fns = getFunctions(app);
await connectEmulatorsIfLocal({ auth, functions: fns });
const call = httpsCallable(fns, 'stormTipsAdmin', { timeout: 300000 });

const $ = (id) => document.getElementById(id);
let view = null;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const REASONS = {
  env_flag_off: 'The storm-tips switch (STORM_TIPS_EMAIL_ENABLED) is off on the server.',
  unknown_issue: 'That email is not in the list.',
  no_storm: 'Pick a storm first.',
  bad_target: 'Pick who it goes to.',
  messaging_paused: 'Customer email is paused, so nothing went out.',
  customer_sends_off: 'Customer messaging is paused, so nothing went out.',
  channel_off: 'Customer email is paused, so nothing went out.',
  controls_missing: 'Customer messaging is not set up, so nothing went out.',
  controls_unreadable: 'Messaging controls could not be read, so nothing went out.',
  no_postal_address: 'Add your mailing address to the Company Profile first (the law needs it on every email).',
  suppression_unreadable: 'The unsubscribe list could not be read, so nothing went out.',
};

function fmtDate(ms) {
  if (!ms) return 'never';
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function say(el, kind, text) {
  el.hidden = false;
  el.setAttribute('data-kind', kind);
  el.textContent = text;
}
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function issueLabel(i) {
  const m = i.months.length === 12 ? 'any month' : i.months.map((x) => MONTHS[x - 1]).join(', ');
  return i.subject + ' (' + m + ')';
}

function renderGates(g) {
  const list = $('stGateList');
  list.textContent = '';
  const rows = [
    ['Storm-tips switch on the server', g.envOn],
    ['Customer email', g.emailAllowed],
    ['Schedule (automation stormTipsEmail)', g.schedule],
  ];
  rows.forEach(([label, on]) => {
    const li = el('li');
    li.appendChild(el('span', '', label));
    const b = el('b', '', on ? 'on' : 'off');
    b.setAttribute('data-on', on ? 'true' : 'false');
    li.appendChild(b);
    list.appendChild(li);
  });
  if (g.canary) {
    const li = el('li');
    li.appendChild(el('span', '', 'Test mode: emails go to you, not the homeowner'));
    const b = el('b', '', 'on');
    b.setAttribute('data-on', 'true');
    li.appendChild(b);
    list.appendChild(li);
  }
}

function renderSend(v) {
  const sel = $('stIssue');
  const keep = sel.value;
  sel.textContent = '';
  v.issues.forEach((i) => {
    const o = el('option', '', issueLabel(i));
    o.value = i.id;
    sel.appendChild(o);
  });
  if (keep) sel.value = keep;
  const st = $('stStorm');
  st.textContent = '';
  if (!v.storms.length) {
    const o = el('option', '', 'No storms in the last 14 days');
    o.value = '';
    st.appendChild(o);
  }
  v.storms.forEach((s) => {
    const what = s.kind === 'hail' && s.mag ? s.mag + '" hail' : (s.kind || 'storm');
    const o = el('option', '', fmtDate(s.atMs) + ' · ' + what + ' · ' + [s.city, s.st].filter(Boolean).join(', ') + ' · ' + s.near + ' near');
    o.value = s.key;
    st.appendChild(o);
  });
}

function flagsFor(s) {
  if (s.unsubscribed) return 'Unsubscribed';
  if (s.stopped) return 'Stopped by you';
  return '';
}

function renderSubs(v) {
  const list = $('stSubList');
  list.textContent = '';
  $('stSubCount').textContent = '(' + v.subscribers.length + ')';
  $('stSubEmpty').hidden = v.subscribers.length > 0;
  v.subscribers.forEach((s) => {
    const li = el('li', 'st-sub');
    const top = el('div', 'st-sub-top');
    const lab = el('label');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.value = s.key;
    cb.className = 'st-pick';
    cb.disabled = s.unsubscribed || s.stopped;
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode(s.email));
    top.appendChild(lab);
    const flag = flagsFor(s);
    if (flag) top.appendChild(el('span', 'st-sub-flag', flag));
    li.appendChild(top);
    const meta = [
      s.zip ? 'ZIP ' + s.zip : 'No ZIP',
      'Opted in ' + fmtDate(s.consentAtMs),
      s.issuesSent.length + ' sent, last ' + fmtDate(s.lastSentAtMs),
      s.scheduleOn ? 'On schedule' + (s.nextScheduled ? ', next: ' + s.nextScheduled : ', nothing due') : 'Not on schedule',
    ].join(' · ');
    li.appendChild(el('div', 'st-sub-meta', meta));
    if (!s.unsubscribed) {
      const acts = el('div', 'st-sub-actions');
      if (!s.stopped) {
        const sched = el('button', 'st-btn st-btn-quiet', s.scheduleOn ? 'Take off schedule' : 'Put on schedule');
        sched.type = 'button';
        sched.disabled = !s.scheduleOn && !s.issuesSent.length;
        if (sched.disabled) sched.title = 'Send them the first email yourself first';
        sched.addEventListener('click', () => setSub(s.key, { scheduleOn: !s.scheduleOn }, sched));
        acts.appendChild(sched);
      }
      const stop = el('button', 'st-btn st-btn-quiet', s.stopped ? 'Allow emails again' : 'Stop all emails');
      stop.type = 'button';
      stop.addEventListener('click', () => setSub(s.key, { stopped: !s.stopped }, stop));
      acts.appendChild(stop);
      li.appendChild(acts);
    }
    list.appendChild(li);
  });
}

async function load() {
  const res = await call({ action: 'list' });
  view = res.data;
  renderGates(view.gates);
  renderSend(view);
  $('stInterval').value = String(view.settings.intervalDays);
  renderSubs(view);
  ['stGates', 'stSend', 'stSchedule', 'stSubs'].forEach((id) => { $(id).hidden = false; });
  $('stLoading').hidden = true;
  $('stMain').setAttribute('aria-busy', 'false');
}

async function setSub(key, patch, btn) {
  btn.disabled = true;
  try {
    const r = await call(Object.assign({ action: 'setSubscriber', key }, patch));
    if (!r.data || !r.data.ok) throw new Error((r.data && r.data.reason) || 'not saved');
    await load();
  } catch (e) {
    btn.disabled = false;
    if (window.showToast) window.showToast('Not saved: ' + (e.message || 'try again'), 'error');
  }
}

$('stTarget').addEventListener('change', () => {
  $('stStormRow').hidden = $('stTarget').value !== 'storm';
});

$('stPreviewBtn').addEventListener('click', async () => {
  const btn = $('stPreviewBtn');
  btn.disabled = true;
  try {
    const r = await call({ action: 'preview', issueId: $('stIssue').value });
    $('stPreviewSubject').textContent = 'Subject: ' + r.data.subject;
    $('stPreviewFrame').srcdoc = r.data.html;
    $('stPreview').hidden = false;
  } catch (e) {
    say($('stSendMsg'), 'err', 'Preview failed: ' + (e.message || 'try again'));
  } finally { btn.disabled = false; }
});

$('stSendBtn').addEventListener('click', async () => {
  const msg = $('stSendMsg');
  const target = $('stTarget').value;
  const req = { action: 'send', issueId: $('stIssue').value, target };
  if (target === 'storm') {
    req.stormKey = $('stStorm').value;
    if (!req.stormKey) { say(msg, 'err', REASONS.no_storm); return; }
  }
  if (target === 'keys') {
    req.keys = Array.from(document.querySelectorAll('.st-pick:checked')).map((c) => c.value);
    if (!req.keys.length) { say(msg, 'err', 'Tick at least one person below.'); return; }
  }
  const ask = window.nbdConfirm || ((o) => Promise.resolve(window.confirm(o.message)));
  const sure = await ask({ title: 'Send storm tips?', message: 'This emails everyone you picked who can get it today (not more than one every 14 days each).', confirmText: 'Send' });
  if (!sure) return;
  const btn = $('stSendBtn');
  btn.disabled = true;
  try {
    const r = await call(req);
    const d = r.data || {};
    if (!d.ok) { say(msg, 'err', REASONS[d.reason] || ('Not sent: ' + d.reason)); return; }
    const skipped = Object.keys(d.skipped || {}).map((k) => d.skipped[k] + ' ' + k.replace(/_/g, ' ')).join(', ');
    let text = 'Sent ' + d.sent + ' of ' + d.chosen + '.';
    if (skipped) text += ' Skipped: ' + skipped + '.';
    if (d.stoppedBy) text += ' Stopped: ' + (REASONS[d.stoppedBy] || d.stoppedBy);
    say(msg, d.stoppedBy ? 'err' : 'ok', text);
    await load();
  } catch (e) {
    say(msg, 'err', 'Send failed: ' + (e.message || 'try again'));
  } finally { btn.disabled = false; }
});

$('stIntervalSave').addEventListener('click', async () => {
  const msg = $('stScheduleMsg');
  const n = Number($('stInterval').value);
  if (!Number.isInteger(n) || n < 14 || n > 365) { say(msg, 'err', 'Pick a whole number from 14 to 365.'); return; }
  try {
    const r = await call({ action: 'setSettings', intervalDays: n });
    $('stInterval').value = String(r.data.intervalDays);
    say(msg, 'ok', 'Saved: every ' + r.data.intervalDays + ' days at most.');
  } catch (e) {
    say(msg, 'err', 'Not saved: ' + (e.message || 'try again'));
  }
});

onAuthStateChanged(auth, (user) => {
  if (!user) { location.href = '/pro/login.html'; return; }
  load().catch((e) => {
    const l = $('stLoading');
    l.textContent = /permission|owner/i.test(String(e && e.message)) ? 'This screen is for the account owner only.' : 'Could not load: ' + ((e && e.message) || 'try again');
    $('stMain').setAttribute('aria-busy', 'false');
  });
});
