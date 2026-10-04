#!/usr/bin/env node
/**
 * Social Studio (2026-10-04) — behaviour tests. No real API calls: the Meta
 * Graph API is a stub fetch, Firestore is an in-memory fake, Storage is a
 * fake bucket. Every assertion runs the real module code.
 *
 *   A. Privacy: a job draft never carries the customer's name, street, house
 *      number, ZIP or GPS — even when the caption tries to.
 *   B. Kentucky filter: claim-handling wording and anything about
 *      deductibles is dropped; the port matches PR #2142's filter when that
 *      file exists.
 *   C. Adapter interface: one shape for every platform; not configured →
 *      not connected; Graph error classification; FB + IG call sequences.
 *   D. Publisher: idempotent (two runs = one post, concurrent too), not
 *      connected → Ready to post + notification, manual platforms, retry with
 *      backoff → failed + alert, unknown outcome never retried, switches,
 *      caption re-check, stale claim, path pinning.
 *   E. Calendar logic: reschedule rules, drop on a day keeps the time, Ready
 *      queue, CSV export (formula-injection safe).
 *   F. Media: the re-encoded copy has no EXIF/GPS (sharp, real bytes).
 *   G. Wiring: rules, index, rewrite, exports, cron gate, nav link, runbook.
 *
 * Run: node tests/social-studio-2026-10-04.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

const L = require(path.join(ROOT, 'functions', 'social-logic.js'));
const A = require(path.join(ROOT, 'functions', 'social-adapters.js'));
const P = require(path.join(ROOT, 'functions', 'social-publisher.js'));
const CW = require(path.join(ROOT, 'functions', 'social-claim-wording.js'));
const S = require(path.join(ROOT, 'docs', 'pro', 'js', 'social-studio-logic.js'));

const LEAD = {
  firstName: 'Margaret', lastName: 'Okonkwo', name: 'Margaret Okonkwo',
  address: '4417 Whispering Pines Dr, Florence, KY 41042',
  phone: '(859) 555-0142', email: 'margaret@example.org',
  lat: 38.99871, lng: -84.62661, acceptedTier: 'better', shingleLine: 'TAMKO Titan XT',
  stage: 'install_complete', stageRole: 'won', companyId: 'co1', userId: 'co1',
};

// ── Fakes ────────────────────────────────────────────────────────────────
function fakeDb() {
  const store = new Map();
  let chain = Promise.resolve();
  function ref(p) {
    return {
      path: p,
      async get() { const d = store.get(p); return { exists: !!d, data: () => (d ? JSON.parse(JSON.stringify(d)) : undefined) }; },
      async update(patch) { if (!store.has(p)) throw new Error('no doc ' + p); store.set(p, Object.assign({}, store.get(p), JSON.parse(JSON.stringify(patch)))); },
      async set(data) { store.set(p, JSON.parse(JSON.stringify(data))); },
    };
  }
  function cg(name) {
    const filters = [];
    let lim = 1e9;
    const q = {
      where(f, op, v) { filters.push([f, op, v]); return q; },
      limit(n) { lim = n; return q; },
      async get() {
        const docs = [];
        for (const [p, d] of store) {
          const segs = p.split('/');
          if (segs[segs.length - 2] !== name) continue;
          const pass = filters.every(([f, op, v]) => (op === '==' ? d[f] === v : op === 'in' ? v.includes(d[f]) : op === '<=' ? (d[f] != null && d[f] <= v) : false));
          if (pass) docs.push({ ref: ref(p), id: segs[segs.length - 1], data: () => JSON.parse(JSON.stringify(store.get(p))) });
        }
        return { docs: docs.slice(0, lim) };
      },
    };
    return q;
  }
  return {
    store,
    doc: ref,
    collectionGroup: cg,
    runTransaction(fn) {
      // Serialised like Firestore's optimistic retries resolve: one at a time.
      const run = chain.then(async () => {
        const writes = [];
        const tx = { get: (r) => r.get(), update: (r, patch) => writes.push([r, patch]) };
        const out = await fn(tx);
        for (const [r, patch] of writes) await r.update(patch);
        return out;
      });
      chain = run.catch(() => {});
      return run;
    },
  };
}

function graphStub(script) {
  const calls = [];
  const fetchFn = async (url, init) => {
    const body = init && init.body ? Object.fromEntries(new URLSearchParams(init.body)) : Object.fromEntries(new URL(url).searchParams);
    const u = new URL(url);
    calls.push({ method: (init && init.method) || 'GET', path: u.pathname.replace('/' + A.GRAPH_VERSION, ''), body });
    const r = script(calls[calls.length - 1], calls.length);
    if (r instanceof Error) throw r;
    return { ok: (r.status || 200) < 400, status: r.status || 200, json: async () => r.body || {} };
  };
  return { fetchFn, calls };
}
const META_ENV = { META_PAGE_ID: 'PAGE1', META_PAGE_ACCESS_TOKEN: 'tok', IG_BUSINESS_ACCOUNT_ID: 'IG1' };
function happyGraph() {
  let n = 0;
  return graphStub((c) => {
    n++;
    if (c.path.endsWith('/photos')) return { body: c.body.published === 'false' ? { id: 'ph' + n } : { id: 'ph' + n, post_id: 'PAGE1_' + n } };
    if (c.path.endsWith('/feed')) return { body: { id: 'PAGE1_' + n } };
    if (c.path.endsWith('/media')) return { body: { id: 'ct' + n } };
    if (c.path.endsWith('/media_publish')) return { body: { id: 'igm' + n } };
    if (c.method === 'GET' && c.body.fields === 'permalink') return { body: { permalink: 'https://www.instagram.com/p/abc/' } };
    if (c.method === 'GET') return { body: { status_code: 'FINISHED' } };
    return { status: 404, body: { error: { message: 'unexpected', code: 100 } } };
  });
}

function seedPost(db, id, over) {
  const p = 'companies/co1/social_posts/' + id;
  db.store.set(p, Object.assign({
    platform: 'facebook', kind: 'job_showcase', status: 'scheduled', scheduledAt: 1000,
    caption: 'New roof in Florence, KY. Call or text me.', hashtags: ['#Florence', '#roofing'],
    media: [{ key: 'a'.repeat(32), role: 'after' }], companyId: 'co1', publish: { attempts: 0 },
  }, over || {}));
  return p;
}
function enable(db, platforms) {
  db.store.set('companies/co1/social_settings/config', { enabled: true, platforms: platforms || {} });
}
const mediaUrl = (k) => 'https://nobigdealwithjoedeal.com/api/social-media?k=' + k;

(async () => {
  // ── A. privacy ──────────────────────────────────────────────────────────
  console.log('A. privacy — names, streets, GPS never reach a post');
  const draft = L.buildJobDraft({ lead: LEAD, platform: 'facebook', media: [{ key: 'b'.repeat(32), role: 'before' }], format: 'single', leadId: 'L1', seed: 3 });
  const blob = JSON.stringify(Object.assign({}, draft, { sourceLeadId: undefined }));
  for (const bad of ['Margaret', 'Okonkwo', 'Whispering', '4417', '41042', '555-0142', 'example.org', '38.99', '84.62']) {
    ok('draft omits "' + bad + '"', blob.indexOf(bad) === -1, blob);
  }
  ok('draft names the town (Florence, KY)', /Florence/.test(draft.caption) && draft.town === 'Florence' && draft.state === 'KY');
  ok('draft carries package + shingle', draft.packageLabel === 'Better package' && draft.shingle === 'TAMKO Titan XT');
  ok('draft is a draft', draft.status === 'draft');
  ok('facts are a whitelist (town/state/package/shingle only)', Object.keys(L.jobFacts(LEAD)).sort().join() === 'packageLabel,shingle,state,town');
  const evil = L.buildJobDraft({ lead: LEAD, platform: 'facebook', media: [], leadId: 'L1',
    caption: 'New roof for Margaret today. We worked at 4417 Whispering Pines Dr all week. Photos at 38.99871, -84.62661. Clean lines in Florence. Call or text me.' });
  ok('a caption naming the customer loses that sentence', !/Margaret/.test(evil.caption));
  ok('a street address sentence is dropped', !/Whispering|4417/.test(evil.caption));
  ok('a GPS coordinate sentence is dropped', !/38\.99|84\.62/.test(evil.caption));
  ok('clean sentences survive', /Clean lines in Florence\./.test(evil.caption) && /Call or text me\./.test(evil.caption), evil.caption);
  ok('a street address with a different house number is dropped too', L.cleanCaption('We finished 12 Oak Street today.', {}).text === '');
  ok('townFromLead refuses a street as the town', L.townFromLead({ city: '12 Main St' }).town === '' && L.townFromLead({ address: '9 Elm Rd, Union Pike, KY 41091' }).town === '');
  ok('townFromLead parses "street, Town ST zip"', L.townFromLead({ address: '1 A St, Fort Thomas KY 41075' }).town === 'Fort Thomas');
  ok('hashtags naming the customer are dropped', L.cleanHashtags(['#MargaretOkonkwo', '#Okonkwo', '#roofing'], { privateTerms: L.privateTerms(LEAD) }).join() === '#roofing');
  ok('hashtags never start with a digit (house numbers)', L.cleanHashtags(['#4417WhisperingPines', '#roofing'], {}).join() === '#roofing');

  // ── B. Kentucky filter ──────────────────────────────────────────────────
  console.log('B. Kentucky claim-wording + deductibles');
  const ky = L.cleanCaption('New roof in Union. We handle your insurance claim from start to finish. We can cover your deductible. Your insurance will pay for a new roof. Call or text me.', {});
  ok('"we handle your insurance claim" dropped', !/handle/.test(ky.text));
  ok('deductible talk dropped', !/deductible/i.test(ky.text));
  ok('insurer-will-pay promise dropped', !/will pay/.test(ky.text));
  ok('the rest survives unchanged', ky.text === 'New roof in Union. Call or text me.', ky.text);
  ok('social rule: ANY deductible mention is dropped (even neutral)', L.cleanCaption('Know your deductible before storm season. Call me.', {}).text === 'Call me.');
  ok('dropped sentences are reported with a rule', ky.dropped.length === 3 && ky.dropped.every((d) => /^(ky:|social:)/.test(d.rule)), JSON.stringify(ky.dropped));
  ok('templates pass the filter untouched', ['job_showcase', 'tip', 'storm_psa', 'review', 'behind_scenes'].every((k) => { const t = L.templateCaption(k, { town: 'Union', state: 'KY' }, 1); return L.cleanCaption(t, {}).text === t.trim(); }));
  const prFile = path.join(ROOT, 'docs', 'pro', 'js', 'claim-wording-filter.js');
  if (fs.existsSync(prFile)) {
    const pr = require(prFile);
    const ids = (r) => r.map((x) => x.id).join();
    ok('port matches docs/pro/js/claim-wording-filter.js rule ids (PR #2142 merged)', ids(pr.ALL_RULES) === ids(CW.ALL_RULES));
  } else {
    ok('PR #2142 not merged yet — port carries its RULES + REPORT_RULES', CW.RULES.length > 20 && CW.REPORT_RULES.some((r) => r.id === 'deductible-games'));
  }

  // ── C. adapters ─────────────────────────────────────────────────────────
  console.log('C. adapter interface');
  const ads = A.makeAdapters({}, async () => { throw new Error('no network in tests'); });
  ok('one interface for every platform', L.PLATFORM_IDS.every((p) => ads[p] && typeof ads[p].connected === 'function' && typeof ads[p].publish === 'function' && typeof ads[p].auto === 'boolean'));
  ok('FB/IG/GBP not connected without secrets', ['facebook', 'instagram', 'gbp'].every((p) => ads[p].connected().ok === false));
  ok('the __unset__ deploy stub counts as not connected', A.makeAdapters({ META_PAGE_ID: '__unset__', META_PAGE_ACCESS_TOKEN: '__unset__' }).facebook.connected().ok === false);
  ok('TikTok/Nextdoor/LinkedIn/X are manual', ['tiktok', 'nextdoor', 'linkedin', 'x'].every((p) => ads[p].auto === false));
  ok('GBP stays off behind its flag even with secrets', A.makeAdapters({ GBP_CLIENT_ID: 'a', GBP_CLIENT_SECRET: 'b', GBP_REFRESH_TOKEN: 'c', GBP_ACCOUNT_ID: 'd', GBP_LOCATION_ID: 'e' }, null, { getGbpAccessToken: async () => 't' }).gbp.connected().ok === false);
  {
    const g = happyGraph();
    const fb = A.makeAdapters(META_ENV, g.fetchFn).facebook;
    const r = await fb.publish({ message: 'hi', mediaUrls: [mediaUrl('a'.repeat(32))] });
    ok('FB single photo: one POST /PAGE1/photos with url + caption', g.calls.length === 1 && g.calls[0].path === '/PAGE1/photos' && g.calls[0].body.caption === 'hi' && g.calls[0].body.access_token === 'tok');
    ok('FB returns post id + facebook.com URL', /^PAGE1_/.test(r.platformPostId) && r.url === 'https://www.facebook.com/' + r.platformPostId);
  }
  {
    const g = happyGraph();
    await A.makeAdapters(META_ENV, g.fetchFn).facebook.publish({ message: 'two', mediaUrls: [mediaUrl('a'.repeat(32)), mediaUrl('b'.repeat(32))] });
    ok('FB multi-photo: 2 unpublished photos then /feed with attached_media', g.calls.length === 3 && g.calls[0].body.published === 'false' && g.calls[2].path === '/PAGE1/feed' && /media_fbid/.test(g.calls[2].body['attached_media[1]'] || ''));
  }
  {
    const g = happyGraph();
    const r = await A.makeAdapters(META_ENV, g.fetchFn, { sleep: async () => {} }).instagram.publish({ message: 'ig', mediaUrls: [mediaUrl('a'.repeat(32)), mediaUrl('b'.repeat(32))] });
    const paths = g.calls.map((c) => c.method + ' ' + c.path);
    ok('IG carousel: 2 child containers, CAROUSEL parent, status check, media_publish, permalink',
      paths.filter((x) => x === 'POST /IG1/media').length === 3 && g.calls[2].body.media_type === 'CAROUSEL' && g.calls[2].body.children === 'ct1,ct2' && paths.includes('POST /IG1/media_publish'), paths.join(' | '));
    ok('IG returns the permalink', r.url === 'https://www.instagram.com/p/abc/');
  }
  {
    let e = null;
    try { await A.makeAdapters(META_ENV, happyGraph().fetchFn).instagram.publish({ message: 'x', mediaUrls: [] }); } catch (err) { e = err; }
    ok('IG with no photo refuses (definite, not retryable)', e && e.code === 'ig_no_media' && !e.retryable);
  }
  {
    const rate = graphStub(() => ({ status: 400, body: { error: { message: 'rate', code: 4 } } }));
    let e = null; try { await A.makeAdapters(META_ENV, rate.fetchFn).facebook.publish({ message: 'x', mediaUrls: [] }); } catch (err) { e = err; }
    ok('Graph rate limit (code 4) → retryable', e && e.retryable && !e.unknown);
    const tok = graphStub(() => ({ status: 400, body: { error: { message: 'expired', code: 190 } } }));
    e = null; try { await A.makeAdapters(META_ENV, tok.fetchFn).facebook.publish({ message: 'x', mediaUrls: [] }); } catch (err) { e = err; }
    ok('Graph bad token (code 190) → definite failure', e && !e.retryable && !e.unknown);
    const net = graphStub(() => new Error('socket hang up'));
    e = null; try { await A.makeAdapters(META_ENV, net.fetchFn).facebook.publish({ message: 'x', mediaUrls: [] }); } catch (err) { e = err; }
    ok('network drop on the publishing call → unknown (never retried)', e && e.unknown && !e.retryable);
    const net2 = graphStub((c, n) => (n === 1 ? new Error('reset') : { body: {} }));
    e = null; try { await A.makeAdapters(META_ENV, net2.fetchFn).facebook.publish({ message: 'x', mediaUrls: [mediaUrl('a'.repeat(32)), mediaUrl('b'.repeat(32))] }); } catch (err) { e = err; }
    ok('network drop on an unpublished photo upload → retryable', e && e.retryable && !e.unknown);
  }

  // ── D. publisher ────────────────────────────────────────────────────────
  console.log('D. publisher');
  {
    const db = fakeDb(); enable(db); const p = seedPost(db, 'p1');
    const g = happyGraph();
    const deps = { db, adapters: A.makeAdapters(META_ENV, g.fetchFn), nowMs: 5000, mediaUrl };
    const c1 = await P.runPublisher(deps);
    const c2 = await P.runPublisher(Object.assign({}, deps, { nowMs: 6000 }));
    const doc = db.store.get(p);
    ok('first run posts', c1.posted === 1 && doc.status === 'posted' && /facebook\.com/.test(doc.postUrl) && doc.platformPostId);
    ok('second run does nothing (two runs = one post)', c2.posted === 0 && g.calls.filter((c) => c.path.endsWith('/photos')).length === 1);
    ok('the Graph call carried the public media URL, never a Storage token', g.calls[0].body.url === mediaUrl('a'.repeat(32)) && !/token=/.test(g.calls[0].body.url));
  }
  {
    const db = fakeDb(); enable(db); seedPost(db, 'p2');
    let photoPosts = 0;
    const slow = graphStub((c) => { if (c.path.endsWith('/photos')) photoPosts++; return { body: { id: 'x', post_id: 'PAGE1_9' } }; });
    const deps = { db, adapters: A.makeAdapters(META_ENV, slow.fetchFn), nowMs: 5000, mediaUrl };
    const [a, b] = await Promise.all([P.runPublisher(deps), P.runPublisher(deps)]);
    ok('two OVERLAPPING runs = one post (claim before publish)', photoPosts === 1 && a.posted + b.posted === 1);
  }
  {
    const db = fakeDb(); enable(db); const p = seedPost(db, 'p3');
    const notes = [];
    const c = await P.runPublisher({ db, adapters: A.makeAdapters({}, null), nowMs: 5000, mediaUrl, notify: async (e) => notes.push(e) });
    ok('not connected → Ready to post (status ready + reason)', c.ready === 1 && db.store.get(p).status === 'ready' && /not_connected/.test(db.store.get(p).readyReason));
    ok('…and ONE notification for the company', notes.length === 1 && notes[0].companyId === 'co1' && notes[0].items.length === 1);
  }
  {
    const db = fakeDb(); enable(db); const p = seedPost(db, 'p4', { platform: 'tiktok' });
    const c = await P.runPublisher({ db, adapters: A.makeAdapters(META_ENV, happyGraph().fetchFn), nowMs: 5000, mediaUrl });
    ok('manual platform (TikTok) → Ready to post even with Meta connected', c.ready === 1 && db.store.get(p).status === 'ready');
  }
  {
    const db = fakeDb(); enable(db); const p = seedPost(db, 'p5');
    const alerts = [];
    const rate = graphStub(() => ({ status: 400, body: { error: { message: 'slow down', code: 17 } } }));
    const deps = { db, adapters: A.makeAdapters(META_ENV, rate.fetchFn), mediaUrl, alert: async (e) => alerts.push(e) };
    let now = 5000;
    await P.runPublisher(Object.assign({}, deps, { nowMs: now }));
    let d = db.store.get(p);
    ok('retryable failure → back to scheduled with backoff', d.status === 'scheduled' && d.publish.attempts === 1 && d.publish.nextAttemptAtMs === now + L.backoffMs(1) && /slow down/.test(d.publish.lastError));
    const early = await P.runPublisher(Object.assign({}, deps, { nowMs: now + 1000 }));
    ok('not retried before nextAttemptAt', early.skipped === 1 && db.store.get(p).publish.attempts === 1);
    for (let i = 0; i < 10 && db.store.get(p).status === 'scheduled'; i++) {
      now = db.store.get(p).publish.nextAttemptAtMs;
      await P.runPublisher(Object.assign({}, deps, { nowMs: now }));
    }
    d = db.store.get(p);
    ok('after MAX_ATTEMPTS → failed (retries_exhausted)', d.status === 'failed' && d.failReason === 'retries_exhausted' && d.publish.attempts === L.MAX_ATTEMPTS, JSON.stringify(d.publish));
    ok('…and Jo is alerted exactly once', alerts.length === 1 && alerts[0].reason === 'retries_exhausted');
    ok('backoff doubles and caps', L.backoffMs(1) === 300000 && L.backoffMs(2) === 600000 && L.backoffMs(20) === 6 * 3600000);
  }
  {
    const db = fakeDb(); enable(db); const p = seedPost(db, 'p6', { media: [] });
    const alerts = [];
    let feedPosts = 0;
    const net = graphStub(() => { feedPosts++; return new Error('timeout'); });
    const deps = { db, adapters: A.makeAdapters(META_ENV, net.fetchFn), nowMs: 5000, mediaUrl, alert: async (e) => alerts.push(e) };
    await P.runPublisher(deps);
    await P.runPublisher(Object.assign({}, deps, { nowMs: 9e9 }));
    ok('unknown outcome → failed + alert, never retried', db.store.get(p).status === 'failed' && db.store.get(p).failReason === 'outcome_unknown' && feedPosts === 1 && alerts.length === 1);
  }
  {
    const db = fakeDb(); const p = seedPost(db, 'p7');
    const c = await P.runPublisher({ db, adapters: A.makeAdapters(META_ENV, happyGraph().fetchFn), nowMs: 5000, mediaUrl });
    ok('company switch off (default) → nothing posts, post stays scheduled', c.paused === 1 && db.store.get(p).status === 'scheduled');
    enable(db, { facebook: false });
    const c2 = await P.runPublisher({ db, adapters: A.makeAdapters(META_ENV, happyGraph().fetchFn), nowMs: 5000, mediaUrl });
    ok('platform switch off → paused', c2.paused === 1 && db.store.get(p).status === 'scheduled');
    const c3 = await P.runPublisher({ db, adapters: A.makeAdapters(META_ENV, happyGraph().fetchFn), nowMs: 5000, mediaUrl, disabled: true });
    ok('global kill switch → nothing scanned', c3.scanned === 0);
  }
  {
    const db = fakeDb(); enable(db);
    db.store.set('leads/L9', LEAD);
    const p = seedPost(db, 'p8', { caption: 'Margaret loves her new roof. Call or text me.', sourceLeadId: 'L9' });
    const alerts = []; const g = happyGraph();
    await P.runPublisher({ db, adapters: A.makeAdapters(META_ENV, g.fetchFn), nowMs: 5000, mediaUrl, alert: async (e) => alerts.push(e) });
    ok('publish-time re-check: a caption naming the customer is refused, not posted', db.store.get(p).status === 'failed' && db.store.get(p).failReason === 'caption_blocked' && g.calls.length === 0 && alerts.length === 1);
    const p2 = seedPost(db, 'p9', { caption: 'We will waive your deductible. Call me.' });
    await P.runPublisher({ db, adapters: A.makeAdapters(META_ENV, g.fetchFn), nowMs: 5000, mediaUrl, alert: async () => {} });
    ok('publish-time re-check: deductible wording refused', db.store.get(p2).status === 'failed' && g.calls.length === 0);
  }
  {
    const db = fakeDb(); enable(db);
    const p = seedPost(db, 'p10', { status: 'publishing', publish: { attempts: 1, claimId: 'c1', claimedAtMs: 1000 } });
    const alerts = []; const g = happyGraph();
    await P.runPublisher({ db, adapters: A.makeAdapters(META_ENV, g.fetchFn), nowMs: 1000 + 60000, mediaUrl, alert: async (e) => alerts.push(e) });
    ok('a fresh publishing claim is left alone', db.store.get(p).status === 'publishing' && g.calls.length === 0);
    await P.runPublisher({ db, adapters: A.makeAdapters(META_ENV, g.fetchFn), nowMs: 1000 + L.STALE_CLAIM_MS + 1, mediaUrl, alert: async (e) => alerts.push(e) });
    ok('a stale claim → failed outcome_unknown + alert, no re-post', db.store.get(p).status === 'failed' && db.store.get(p).failReason === 'outcome_unknown' && g.calls.length === 0 && alerts.length === 1);
  }
  {
    const db = fakeDb(); enable(db);
    db.store.set('users/u1/social_posts/x', { platform: 'facebook', status: 'scheduled', scheduledAt: 1, caption: 'x', media: [] });
    const g = happyGraph();
    const c = await P.runPublisher({ db, adapters: A.makeAdapters(META_ENV, g.fetchFn), nowMs: 5000, mediaUrl });
    ok('a social_posts collection outside companies/{id}/ is ignored', c.skipped === 1 && g.calls.length === 0);
  }
  {
    const db = fakeDb(); enable(db); const p = seedPost(db, 'p11', { scheduledAt: 99999 });
    const c = await P.runPublisher({ db, adapters: A.makeAdapters(META_ENV, happyGraph().fetchFn), nowMs: 5000, mediaUrl });
    ok('a future post is not touched', c.scanned === 0 && db.store.get(p).status === 'scheduled');
  }

  // ── E. calendar logic ──────────────────────────────────────────────────
  console.log('E. calendar + export');
  const NOW = Date.UTC(2026, 9, 4, 16, 0); // 2026-10-04 12:00 ET
  const tue9 = S.zonedMs(2026, 10, 6, 9, 0);
  ok('zonedMs: 9:00 ET in October is 13:00 UTC', new Date(tue9).getUTCHours() === 13);
  const sched = { id: 'a', status: 'scheduled', scheduledAt: tue9, platform: 'facebook' };
  const r1 = S.dropOnDay(sched, '2026-10-09', NOW);
  ok('drop on a day keeps the time of day (Fri 9:00 ET)', r1.ok && r1.patch.scheduledAtMs === S.zonedMs(2026, 10, 9, 9, 0) && !r1.patch.status);
  ok('a posted post cannot move', S.reschedule({ status: 'posted' }, tue9, NOW).ok === false);
  ok('a publishing post cannot move', S.reschedule({ status: 'publishing' }, tue9, NOW).ok === false);
  ok('the past is refused', S.reschedule(sched, NOW - 3600000, NOW).ok === false);
  ok('approved + dated becomes scheduled', S.reschedule({ status: 'approved' }, tue9, NOW).patch.status === 'scheduled');
  ok('a ready post moved to the future goes back to scheduled', S.reschedule({ status: 'ready' }, tue9, NOW).patch.status === 'scheduled');
  ok('datetime-local round trip is Eastern', S.fromLocalInput(S.toLocalInput(tue9)) === tue9 && S.toLocalInput(tue9) === '2026-10-06T09:00');
  const grid = S.monthGrid(2026, 10);
  ok('month grid: Sun-start weeks covering Oct 1 (a Thursday)', grid[0][4].key === '2026-10-01' && grid[0][0].inMonth === false && grid.every((w) => w.length === 7));
  ok('week keys: Sun..Sat around an anchor', S.weekKeys(NOW).join() === '2026-10-04,2026-10-05,2026-10-06,2026-10-07,2026-10-08,2026-10-09,2026-10-10');
  const buckets = S.bucketByDay([sched, { id: 'b', status: 'scheduled', scheduledAt: tue9, platform: 'instagram' }, { id: 'c', status: 'cancelled', scheduledAt: tue9, platform: 'x' }]);
  ok('bucketByDay: per-day, per-platform lanes; cancelled hidden', buckets['2026-10-06'].facebook.length === 1 && buckets['2026-10-06'].instagram.length === 1 && !buckets['2026-10-06'].x);
  const rq = S.readyQueue([{ status: 'ready', platform: 'facebook', scheduledAt: 1 }, { status: 'scheduled', platform: 'tiktok', scheduledAt: 1 }, { status: 'scheduled', platform: 'tiktok', scheduledAt: NOW + 1e7 }, { status: 'scheduled', platform: 'facebook', scheduledAt: 1 }], NOW);
  ok('Ready queue: ready + due manual-platform posts only', rq.length === 2);
  const csv = S.toCSV([{ id: 'x', platform: 'facebook', caption: '=HYPERLINK("http://evil")', hashtags: ['#a'], media: [{ key: 'k' }], scheduledAt: tue9 }], '/api/social-media');
  ok('CSV: formula injection neutralised + quoting', /"'=HYPERLINK\(""http:\/\/evil""\)"/.test(csv), csv);
  ok('CSV: media exported as public URLs', /\/api\/social-media\?k=k/.test(csv));
  const json = JSON.parse(S.toJSON([{ id: 'x', platform: 'facebook', caption: 'c', postUrl: 'https://f/1', status: 'posted' }], '', { companyId: 'co1', nowMs: NOW }));
  ok('JSON export carries caption + result URL', json.count === 1 && json.posts[0].postUrl === 'https://f/1' && json.companyId === 'co1');

  // planWeeks
  const plan = L.planWeeks({ weeks: 2, platforms: ['facebook', 'instagram'], startMs: NOW, jobs: [{ leadId: 'L1', facts: { town: 'Union', state: 'KY' }, format: 'before_after' }], reviews: [{ text: 'Joe did a great job on our roof and cleaned up every nail.' }], seed: 1 });
  const kinds = new Set(plan.map((p) => p.kind));
  ok('Plan 2 weeks: a mix of kinds (showcase, tip/PSA, review, behind the scenes)', kinds.has('job_showcase') && kinds.has('review') && kinds.has('behind_scenes') && (kinds.has('tip') || kinds.has('storm_psa')), Array.from(kinds).join());
  ok('Plan: text-only posts skip Instagram (needs a photo)', plan.filter((p) => p.platform === 'instagram').every((p) => p.format !== 'text'));
  ok('Plan: every caption passes the filter', plan.every((p) => L.cleanCaption(p.caption, {}).dropped.length === 0));
  ok('Plan: posts land in the future, at the slot times', plan.every((p) => p.scheduledAtMs > NOW));

  // choosePhotos
  const sel = L.choosePhotos([{ id: '1', storagePath: 'photos/u/1.jpg', phase: 'Before', createdAt: 1 }, { id: '2', storagePath: 'photos/u/2.jpg', phase: 'After', createdAt: 2 }, { id: '3', phase: 'After' }]);
  ok('choosePhotos: before/after pair, photos without a Storage path skipped', sel.format === 'before_after' && sel.photos.map((p) => p.role).join() === 'before,after');
  ok('choosePhotos: web-form photos (path, not storagePath) are usable', L.choosePhotos([{ id: '9', path: 'homeowner-uploads/u/x.jpg' }]).photos.length === 1);

  // ── F. media re-encode ─────────────────────────────────────────────────
  console.log('F. media — the posted copy has no EXIF/GPS');
  let sharp = null;
  try { sharp = require(require.resolve('sharp', { paths: [path.join(ROOT, 'functions')] })); } catch (_) { sharp = null; }
  if (!sharp) {
    ok('sharp unavailable here — F skipped (CI installs functions deps)', true);
  } else {
    const withGps = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 80, b: 40 } } })
      .jpeg().withExifMerge({ IFD0: { Make: 'TestPhone' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '38/1 59/1 55/1', GPSLongitudeRef: 'W', GPSLongitude: '84/1 37/1 36/1' } }).toBuffer();
    const meta0 = await sharp(withGps).metadata();
    ok('positive control: the source JPEG carries EXIF', !!meta0.exif && withGps.includes(Buffer.from('Exif')));
    const SS = require(path.join(ROOT, 'functions', 'social-studio.js'))._test;
    const saved = new Map();
    const bucket = { file: (p) => ({ download: async () => [withGps], save: async (buf) => { saved.set(p, buf); } }) };
    const db = { doc: (p) => ({ set: async (d) => { saved.set(p, d); } }) };
    const out = await SS.prepareMedia(db, 'co1', [{ storagePath: 'photos/co1/a.jpg', role: 'after' }, { storagePath: 'leads/secret.jpg', role: 'x' }], { bucket });
    const file = Array.from(saved.keys()).find((k) => k.startsWith('social-media/'));
    const meta1 = await sharp(saved.get(file)).metadata();
    ok('one media key minted; a non-photo path is refused', out.length === 1 && /^[a-f0-9]{32}$/.test(out[0].key));
    ok('the stored copy has NO EXIF (GPS gone)', !meta1.exif && !saved.get(file).includes(Buffer.from('Exif')) && !saved.get(file).includes(Buffer.from('TestPhone')));
    ok('the index doc points only at the social-media/ copy', saved.get('social_media/' + out[0].key).path === file && file === 'social-media/co1/' + out[0].key + '.jpg');
    ok('mediaUrl is the same-origin public endpoint, never a token URL', SS.mediaUrl(out[0].key) === 'https://nobigdealwithjoedeal.com/api/social-media?k=' + out[0].key && SS.mediaUrl('../x') === '');
    const t = (tok) => { try { SS.requireSocialManager({ auth: { uid: 'u1', token: tok } }); return true; } catch (_) { return false; } };
    ok('gate: solo owner, company_admin, platform admin in; viewer, rep, manager out',
      t({}) && t({ companyId: 'co9', role: 'company_admin' }) && t({ role: 'admin' }) && !t({ companyId: 'u1', role: 'viewer' }) && !t({ companyId: 'co9', role: 'sales_rep' }) && !t({ companyId: 'co9', role: 'manager' }));
  }

  // ── G. wiring ──────────────────────────────────────────────────────────
  console.log('G. wiring');
  const rules = read('firestore.rules');
  ok('rules: social_posts under companies/{companyId}', /match \/companies\/\{companyId\}[\s\S]*match \/social_posts\/\{postId\}/.test(rules));
  ok('rules: client create must be a draft', /request\.resource\.data\.status == 'draft'[\s\S]{0,200}approvedAt/.test(rules));
  ok('rules: content edit → draft; approved/scheduled only from approved/scheduled/ready', /!socialContentChanged\(\) \|\| after == 'draft'/.test(rules) && /after in \['approved', 'scheduled'\] && before in \['approved', 'scheduled', 'ready'\]/.test(rules));
  ok('rules: server fields frozen', /didNotChange\(\['companyId', 'createdBy', 'approvedAt', 'approvedBy', 'publish', 'platformPostId'/.test(rules));
  ok('rules: social_media index is server-only', /match \/social_media\/\{key\}\s*\{ allow read, write: if false; \}/.test(rules));
  const idx = JSON.parse(read('firestore.indexes.json'));
  ok('index: social_posts COLLECTION_GROUP (status, scheduledAt)', idx.indexes.some((i) => i.collectionGroup === 'social_posts' && i.queryScope === 'COLLECTION_GROUP' && i.fields.map((f) => f.fieldPath).join() === 'status,scheduledAt'));
  const fb = JSON.parse(read('firebase.json'));
  ok('hosting: /api/social-media → socialMedia', fb.hosting.rewrites.some((r) => r.source === '/api/social-media' && r.function && r.function.functionId === 'socialMedia'));
  const index = read('functions/index.js');
  ok('functions/index.js exports all six', ['socialEligibleJobs', 'socialDraftFromJob', 'socialPlanWeeks', 'socialApprovePost', 'socialPublisher', 'socialMedia'].every((n) => new RegExp('exports\\.' + n + ' = socialStudio\\.' + n).test(index)));
  const gates = require(path.join(ROOT, 'functions', 'cron-gates.js')).CRON_GATES.map((g) => g.name);
  ok('cron gates registered', gates.includes('SOCIAL_PUBLISHER_DISABLED') && gates.includes('SOCIAL_GBP_ENABLED'));
  const page = read('docs/pro/social.html');
  ok('page: no inline scripts / handlers / styles', !/<script>(?!<)/.test(page) && !/<script(?![^>]*\bsrc=)[^>]*>/.test(page) && !/\son[a-z]+=/i.test(page) && !/\sstyle=/.test(page));
  ok('page: module + logic loaded', /js\/pages\/social-studio\.js/.test(page) && /js\/social-studio-logic\.js/.test(page));
  ok('dashboard nav links to Social Studio (desktop + phone)', /id="nav-social"/.test(read('docs/pro/dashboard.html')) && /id="mm-social"/.test(read('docs/pro/dashboard.html')));
  const mod = read('docs/pro/js/pages/social-studio.js');
  ok('page module: AI via the claudeProxy with the Haiku 4.5 model id', /window\.callClaude/.test(mod) && /claude-haiku-4-5-20251001/.test(mod));
  ok('page module: no style= strings', !/style=/.test(mod));
  ok('runbook exists and is linked from INDEX', fs.existsSync(path.join(ROOT, 'documentation/runbooks/SOCIAL-PUBLISHER-SETUP.md')) && /runbooks\/SOCIAL-PUBLISHER-SETUP\.md/.test(read('documentation/INDEX.md')));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
