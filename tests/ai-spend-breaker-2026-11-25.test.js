/**
 * tests/ai-spend-breaker-2026-11-25.test.js
 *
 * Roadmap step 12 (documentation/audit/BOTS-AGENTS-SCHEDULES-REVIEW-2026-11-22.md
 * §3.2): one AI gate (functions/ai-gate.js aiGate) = the plan check AND a
 * daily spend breaker. Runs the real gate and the real recordAiSpend over an
 * in-memory Firestore; no network.
 *
 *   1. cap math: 3 x the busiest measured day ($0.46) = $1.38, the $5 floor,
 *      the single config value, per-plan caps as a share of it
 *   2. the breaker: platform cap, per-company cap, company isolation, public
 *      callers, the stop-all switch
 *   3. one alert per day per cap
 *   4. limits / spend read failure fails OPEN; plan read failure fails CLOSED
 *   5. recordAiSpend writes the per-company counter the breaker reads, and
 *      the breaker reads it through a short cache (not once per call)
 *
 * Run: node tests/ai-spend-breaker-2026-11-25.test.js
 */
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0; const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); failed++; fails.push(label); }
}

// ── in-memory Firestore (doc / collection / set+merge / increment / create) ──
const INC = (n) => ({ __inc: n });
function mergeInto(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && '__inc' in v) target[k] = (Number(target[k]) || 0) + v.__inc;
    else if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) target[k] = mergeInto(Object.assign({}, target[k] || {}), v);
    else target[k] = v;
  }
  return target;
}
function makeDb(seed, opts) {
  const store = new Map(Object.entries(seed || {}));
  const reads = [];
  let auto = 0;
  const o = opts || {};
  function doc(p) {
    return {
      get: async () => {
        reads.push(p);
        if (o.throwOn && o.throwOn.test(p)) throw new Error('firestore down');
        return { exists: store.has(p), data: () => store.get(p) };
      },
      set: async (d, so) => { store.set(p, so && so.merge ? mergeInto(Object.assign({}, store.get(p) || {}), d) : mergeInto({}, d)); },
      create: async (d) => { if (store.has(p)) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; } store.set(p, mergeInto({}, d)); },
      delete: async () => { store.delete(p); },
    };
  }
  return {
    store, reads,
    doc,
    collection: (c) => ({ doc: (id) => doc(c + '/' + id), add: async (d) => { const p = c + '/auto' + (++auto); store.set(p, d); return { id: 'auto' + auto }; } }),
  };
}
const FV = { increment: INC, serverTimestamp: () => 'ts' };
const rows = (db, prefix) => [...db.store.keys()].filter((k) => k.startsWith(prefix));

const NOW = Date.parse('2026-11-25T17:00:00Z'); // 12:00 ET
const DAY = '2026-11-25';
const TOMORROW = NOW + 86_400_000;
const SUBS = {
  'subscriptions/growthCo': { plan: 'growth', status: 'active' },
  'subscriptions/starterCo': { plan: 'starter', status: 'active' },
  'subscriptions/teamCo': { plan: 'team', status: 'active' },
  'subscriptions/freeCo': { plan: 'free', status: 'none' },
};
const paid = (co, extra) => ({ auth: { uid: 'u_' + co, token: Object.assign({ companyId: co, email_verified: true }, extra || {}) } });

(async () => {
  const G = require(path.join(ROOT, 'functions', 'ai-gate.js'));
  const S = require(path.join(ROOT, 'functions', 'ai-spend.js'));
  const flagsWith = (limits) => async () => (limits === undefined ? {} : { aiSpendLimits: limits });
  const gate = (db, opts, flags, extra) => G.aiGate(db, Object.assign({ nowMs: NOW, feature: 'test', deps: Object.assign({ getFlags: flags || flagsWith() }, extra || {}) }, opts));

  console.log('\n1. cap math');
  ok('the formula cap is 3 x the busiest measured day ($0.46 → $1.38, integer micro-dollars)',
    G.capFromBusiestDay(460000, 3) === 1380000 && G.FORMULA_PLATFORM_DAILY_MICROS === 1380000, G.FORMULA_PLATFORM_DAILY_MICROS);
  ok('the alternative floor is $5/day', G.ALT_FLOOR_PLATFORM_DAILY_MICROS === 5000000);
  let L = G.resolveLimits(undefined);
  ok('no config → the formula value is the active platform cap', L.platformMicros === 1380000 && L.stopAll === false, L);
  const caps = (lim) => ({ starter: G.companyCapMicros(lim, 'starter'), team: G.companyCapMicros(lim, 'team'), growth: G.companyCapMicros(lim, 'growth'), enterprise: G.companyCapMicros(lim, 'enterprise'), platform: G.companyCapMicros(lim, 'platform') });
  ok('per-plan caps by default are the plan price share of the platform cap (Team $149 of $299)',
    G.companyCapMicros(L, 'team') === Math.floor(1380000 * 149 / 299), caps(L));
  ok('no single company (Growth, Enterprise, the platform tenant included) can spend the whole platform cap: at most half of it',
    ['growth', 'professional', 'enterprise', 'platform'].every((k) => G.companyCapMicros(L, k) === 690000), caps(L));
  ok('no plan\'s default is below the busiest measured day ($0.46): Starter\'s $0.457 share is lifted to it',
    G.companyCapMicros(L, 'starter') === 460000 && Math.floor(1380000 * 99 / 299) < 460000, caps(L));
  ok('an unknown paid plan gets the smallest (Starter) share, never more', G.companyCapMicros(L, 'mystery') === G.companyCapMicros(L, 'starter'));
  L = G.resolveLimits({ platformDailyUsd: 5 });
  ok('ONE config value moves the platform cap (platformDailyUsd: 5 → $5) and the per-plan caps with it',
    L.platformMicros === 5000000 && G.companyCapMicros(L, 'starter') === Math.floor(5000000 * 99 / 299) && G.companyCapMicros(L, 'growth') === 2500000, caps(L));
  ok('…and the public endpoints\' own cap (half the platform cap by default; publicDailyUsd overrides it)',
    L.publicMicros === 2500000 && G.resolveLimits(undefined).publicMicros === 690000 && G.resolveLimits({ publicDailyUsd: 1 }).publicMicros === 1000000, L);
  L = G.resolveLimits({ platformDailyUsd: 5, perPlanDailyUsd: { team: 2 } });
  ok('a per-plan override wins for that plan only', G.companyCapMicros(L, 'team') === 2000000 && G.companyCapMicros(L, 'growth') === 2500000, caps(L));
  for (const bad of [-1, 0, 'lots', NaN, Infinity, null]) {
    ok('a bad platformDailyUsd (' + String(bad) + ') falls back to the formula value', G.resolveLimits({ platformDailyUsd: bad }).platformMicros === 1380000);
  }
  ok('a per-plan cap is never above the platform cap', G.companyCapMicros(G.resolveLimits({ perPlanDailyUsd: { team: 50 } }), 'team') === 1380000);

  console.log('\n2. the breaker');
  G._resetBreakerCache();
  let db = makeDb(Object.assign({}, SUBS));
  let r = await gate(db, paid('growthCo'));
  ok('a paid company with no spend today → allowed, billed to its company', r.ok === true && r.companyId === 'growthCo', r);

  G._resetBreakerCache();
  db = makeDb(Object.assign({ ['ai_spend_daily/' + DAY]: { usdMicros: 1380000 } }, SUBS));
  r = await gate(db, paid('growthCo'));
  ok('platform spend at the cap → refused "AI paused until tomorrow (daily limit)"',
    r.ok === false && r.reason === 'platform_cap' && r.message === 'AI paused until tomorrow (daily limit).', r);
  ok('…as resource-exhausted / HTTP 429', r.code === 'resource-exhausted' && r.status === 429, r);
  r = await gate(db, { publicCaller: true });
  ok('a public (unauthenticated) caller is held to the platform cap too', r.ok === false && r.reason === 'platform_cap', r);
  G._resetBreakerCache();
  r = await gate(db, paid('growthCo'), flagsWith({ platformDailyUsd: 5 }));
  ok('raising the one config value ($5) lets the same spend through', r.ok === true, r);

  G._resetBreakerCache();
  db = makeDb(Object.assign({
    ['ai_spend_daily/' + DAY]: { usdMicros: 600000 },
    ['ai_spend_daily_co/' + DAY + '__starterCo']: { usdMicros: 460000 },
  }, SUBS));
  r = await gate(db, paid('starterCo'));
  ok('a Starter company past its share ($0.46 of $1.38) → refused company_cap', r.ok === false && r.reason === 'company_cap' && r.message === 'AI paused until tomorrow (daily limit).', r);
  r = await gate(db, paid('growthCo'));
  ok('…another company the same day is not affected (per-company isolation)', r.ok === true, r);
  r = await gate(db, paid('teamCo'));
  ok('…nor a Team company with no spend', r.ok === true, r);
  r = await gate(db, { publicCaller: true });
  ok('…nor the public endpoints (platform cap only)', r.ok === true, r);

  G._resetBreakerCache();
  const pubDay = (vis, fun, tenant) => ({ usdMicros: vis + fun + (tenant || 0), features: { 'public-visualizer': { usdMicros: vis }, 'public-funnel': { usdMicros: fun } } });
  db = makeDb(Object.assign({ ['ai_spend_daily/' + DAY]: pubDay(1000000, 500000) }, SUBS));
  r = await gate(db, paid('growthCo'));
  ok('anonymous public spend past the platform cap ($1.50, all public) does NOT pause a paying tenant', r.ok === true, r);
  r = await gate(db, { companyId: 'growthCo' });
  ok('…nor an unattended pipeline for a tenant', r.ok === true, r);
  r = await gate(db, { publicCaller: true });
  ok('…but the public endpoints are over their own cap ($0.69 default) → refused public_cap, "AI paused until tomorrow"',
    r.ok === false && r.reason === 'public_cap' && r.code === 'resource-exhausted' && r.message === 'AI paused until tomorrow (daily limit).', r);
  G._resetBreakerCache();
  db = makeDb(Object.assign({ ['ai_spend_daily/' + DAY]: pubDay(300000, 100000, 1380000) }, SUBS));
  r = await gate(db, paid('growthCo'));
  ok('tenant spend at the platform cap (public spend on top) → refused platform_cap', r.ok === false && r.reason === 'platform_cap', r);
  r = await gate(db, { publicCaller: true });
  ok('…and the public endpoints with it (the platform cap pauses every AI feature)', r.ok === false && r.reason === 'platform_cap', r);

  G._resetBreakerCache();
  db = makeDb(Object.assign({
    ['ai_spend_daily/' + DAY]: { usdMicros: 690000 },
    ['ai_spend_daily_co/' + DAY + '__growthCo']: { usdMicros: 690000 },
  }, SUBS));
  r = await gate(db, paid('growthCo'));
  ok('a Growth company at half the platform cap → refused company_cap (it alone cannot pause everyone)', r.ok === false && r.reason === 'company_cap', r);
  r = await gate(db, paid('teamCo'));
  ok('…and every other company still runs', r.ok === true, r);
  G._resetBreakerCache();
  db = makeDb(Object.assign({
    ['ai_spend_daily/' + DAY]: { usdMicros: 700000 },
    ['ai_spend_daily_co/' + DAY + '__' + G.PLATFORM_UID]: { usdMicros: 700000 },
  }, SUBS));
  r = await gate(db, { companyId: G.PLATFORM_UID });
  ok('the platform tenant has a company cap too (a burst of its own cannot pause paying tenants)', r.ok === false && r.reason === 'company_cap', r);
  r = await gate(db, paid('growthCo'));
  ok('…while a paying tenant still runs', r.ok === true, r);

  G._resetBreakerCache();
  db = makeDb(Object.assign({}, SUBS));
  for (const [label, opts] of [['a paid company', paid('growthCo')], ['the platform admin', { auth: { uid: 'adm', token: { role: 'admin' } } }], ['a public caller', { publicCaller: true }]]) {
    r = await gate(db, opts, flagsWith({ stopAll: true }));
    ok('stopAll (the breaker\'s kill switch) refuses ' + label, r.ok === false && r.reason === 'paused' && r.code === 'unavailable', r);
  }
  ok('the stop-all refusal spends no plan read', !db.reads.some((p) => p.startsWith('subscriptions/')), db.reads);

  console.log('\n3. one alert per day per cap');
  G._resetBreakerCache();
  db = makeDb(Object.assign({
    ['ai_spend_daily/' + DAY]: { usdMicros: 1500000 },
    ['ai_spend_daily/2026-11-26']: { usdMicros: 1500000 },
  }, SUBS));
  const sent = [];
  const sendAlert = async (d, a) => { sent.push(a); };
  for (let i = 0; i < 4; i++) await gate(db, paid('growthCo'), null, { sendAlert });
  await gate(db, { publicCaller: true }, null, { sendAlert });
  ok('five refusals on the platform cap → ONE alert', sent.length === 1 && sent[0].cap === 'platform' && sent[0].day === DAY, sent);
  G._resetBreakerCache(); // a fresh instance (cold start) must not send it again
  await gate(db, paid('growthCo'), null, { sendAlert });
  ok('…a fresh instance the same day sends nothing more (the claim is in Firestore)', sent.length === 1, sent.length);
  G._resetBreakerCache();
  await G.aiGate(db, Object.assign({ nowMs: TOMORROW, deps: { getFlags: flagsWith(), sendAlert } }, paid('growthCo')));
  ok('…the next day\'s trip alerts again', sent.length === 2 && sent[1].day === '2026-11-26', sent.map((s) => s.day));
  G._resetBreakerCache();
  db.store.set('ai_spend_daily_co/' + DAY + '__starterCo', { usdMicros: 999999 });
  db.store.set('ai_spend_daily/' + DAY, { usdMicros: 1000 });
  await gate(db, paid('starterCo'), null, { sendAlert });
  await gate(db, paid('starterCo'), null, { sendAlert });
  ok('a company cap is its own cap: one alert for it, naming the company', sent.length === 3 && sent[2].cap === 'company' && sent[2].companyId === 'starterCo', sent[2]);
  G._resetBreakerCache();
  const failing = async () => { throw new Error('queue down'); };
  db = makeDb(Object.assign({ ['ai_spend_daily/' + DAY]: { usdMicros: 1500000 } }, SUBS));
  r = await gate(db, paid('growthCo'), null, { sendAlert: failing });
  ok('a failed alert send never turns the refusal into a crash', r.ok === false && r.reason === 'platform_cap', r);
  const retried = [];
  r = await gate(db, paid('growthCo'), null, { sendAlert: async (d, a) => { retried.push(a); } });
  ok('…and the next refusal sends it (a failed send does not use up the day\'s one alert)', retried.length === 1 && retried[0].cap === 'platform', retried);
  G._resetBreakerCache();
  await gate(db, paid('growthCo'), null, { sendAlert: async (d, a) => { retried.push(a); } });
  ok('…once: after a delivered alert another instance sends nothing more', retried.length === 1, retried.length);
  G._resetBreakerCache();
  db = makeDb(Object.assign({ ['ai_spend_daily/' + DAY]: { usdMicros: 700000, features: { 'public-visualizer': { usdMicros: 700000 } } } }, SUBS));
  sent.length = 0;
  await gate(db, { publicCaller: true }, null, { sendAlert });
  await gate(db, { publicCaller: true }, null, { sendAlert });
  ok('the public cap is its own cap: one alert for it', sent.length === 1 && sent[0].cap === 'public', sent);
  G._resetBreakerCache();
  db = makeDb(Object.assign({ ['ai_spend_daily/' + DAY]: { usdMicros: 1500000 } }, SUBS));
  await gate(db, paid('growthCo'));
  const queued = rows(db, 'email_queue/').map((k) => db.store.get(k));
  ok('the default alert path queues ONE owner email (status pending, kind ai_spend_breaker_alert)',
    queued.length === 1 && queued[0].status === 'pending' && queued[0].kind === 'ai_spend_breaker_alert' && /\$1\.38/.test(queued[0].bodyPlain), queued);

  console.log('\n4. fail open on limits, fail closed on plan');
  G._resetBreakerCache();
  db = makeDb(Object.assign({}, SUBS));
  r = await gate(db, paid('growthCo'), async () => { throw new Error('flags down'); });
  ok('a failed limits read fails OPEN (default limits, AI runs)', r.ok === true, r);
  G._resetBreakerCache();
  db = makeDb(Object.assign({}, SUBS), { throwOn: /^ai_spend_daily/ });
  r = await gate(db, paid('growthCo'));
  ok('a failed spend-total read fails OPEN (accounting never blocks AI)', r.ok === true, r);
  const warned = [];
  const realWarn = console.warn;
  console.warn = (...a) => { warned.push(a); };
  try {
    G._resetBreakerCache();
    for (let i = 0; i < 5; i++) await gate(db, paid('growthCo'));
  } finally { console.warn = realWarn; }
  const readWarns = warned.filter((a) => a[0] === 'ai_spend_breaker_read_failed');
  ok('…but never silently: the failed read is logged, once per counter per cache window (not once per call)',
    readWarns.length === 2 && readWarns.every((a) => a[1] && /^ai_spend_daily/.test(a[1].path)), warned);
  G._resetBreakerCache();
  db = makeDb(Object.assign({}, SUBS), { throwOn: /^subscriptions\// });
  r = await gate(db, paid('growthCo'));
  ok('a failed plan read fails CLOSED (plan_check_failed, unavailable)', r.ok === false && r.reason === 'plan_check_failed' && r.code === 'unavailable', r);
  G._resetBreakerCache();
  db = makeDb(Object.assign({}, SUBS));
  r = await gate(db, paid('freeCo'));
  ok('a free plan is refused (plan) before any spend read', r.ok === false && r.reason === 'plan' && r.status === 403 && !db.reads.some((p) => p.startsWith('ai_spend')), { r, reads: db.reads });
  r = await gate(db, { companyId: 'freeCo' });
  ok('tenant mode (an unattended pipeline for a company) checks that company\'s own plan', r.ok === false && r.reason === 'plan', r);
  r = await gate(db, { companyId: 'growthCo' });
  ok('…and lets a paid tenant through', r.ok === true && r.companyId === 'growthCo', r);
  db.store.set('subscriptions/opsCo', { platformTenant: true });
  r = await gate(db, { companyId: 'opsCo' });
  ok('the platform tenant is known from its OWN plan data (platformTenant: true), with the platform cap', r.ok === true && r.capKey === 'platform', r);
  r = await gate(db, { auth: { uid: 'x', token: { companyId: 'opsCo', email_verified: true } } });
  ok('…for its signed-in users too', r.ok === true && r.capKey === 'platform', r);
  r = await gate(db, {});
  ok('no caller and no tenant → refused (never a silent pass)', r.ok === false, r);
  const P = G.PLATFORM_UID;
  db.store.set('subscriptions/' + P, { platformTenant: true });
  db.reads.length = 0;
  r = await gate(db, { companyId: P });
  ok('the real platform uid is decided by its OWN plan doc first (platformTenant: true → read, platform cap)',
    r.ok === true && r.capKey === 'platform' && db.reads.includes('subscriptions/' + P), { r, reads: db.reads });
  db.reads.length = 0;
  r = await gate(db, { auth: { uid: P, token: { companyId: P } } });
  ok('…for its signed-in owner too', r.ok === true && r.capKey === 'platform' && db.reads.includes('subscriptions/' + P), { r, reads: db.reads });
  db.store.delete('subscriptions/' + P);
  r = await gate(db, { companyId: P });
  ok('…and until that field is set, the uid fallback still keeps the platform running (no lock-out)', r.ok === true && r.capKey === 'platform', r);
  G._resetBreakerCache();
  const dbDown = makeDb(Object.assign({}, SUBS), { throwOn: /^subscriptions\// });
  r = await gate(dbDown, { companyId: P });
  ok('…a failed plan read for the platform tenant falls back the same way (it never read a plan before this change)', r.ok === true && r.capKey === 'platform', r);
  r = await gate(dbDown, { companyId: 'growthCo' });
  ok('…while every other tenant still fails CLOSED on it', r.ok === false && r.reason === 'plan_check_failed', r);

  console.log('\n5. recordAiSpend feeds the per-company counter; reads are cached');
  G._resetBreakerCache();
  db = makeDb(Object.assign({}, SUBS));
  const rec = await S.recordAiSpend({ feature: 'x', model: 'claude-haiku-4-5', inputTokens: 300000, outputTokens: 40000, companyId: 'starterCo' }, { db, nowMs: NOW, FieldValue: FV });
  ok('recordAiSpend with a companyId writes ai_spend_daily_co/{day}__{companyId}', rec.ok === true
    && (db.store.get('ai_spend_daily_co/' + DAY + '__starterCo') || {}).usdMicros === 500000
    && (db.store.get('ai_spend_daily_co/' + DAY + '__starterCo') || {}).companyId === 'starterCo', db.store.get('ai_spend_daily_co/' + DAY + '__starterCo'));
  ok('…and still the platform day/month docs', (db.store.get('ai_spend_daily/' + DAY) || {}).usdMicros === 500000 && db.store.has('ai_spend_monthly/2026-11'));
  await S.recordAiSpend({ feature: 'x', model: 'claude-haiku-4-5', inputTokens: 1 }, { db, nowMs: NOW, FieldValue: FV });
  await S.recordAiSpend({ feature: 'x', model: 'claude-haiku-4-5', inputTokens: 1, companyId: 'a/b' }, { db, nowMs: NOW, FieldValue: FV });
  ok('no companyId (or an unsafe one) → no per-company doc', rows(db, 'ai_spend_daily_co/').length === 1, rows(db, 'ai_spend_daily_co/'));
  r = await gate(db, paid('starterCo'));
  ok('the breaker reads that counter: $0.50 > Starter\'s $0.46 share → refused', r.ok === false && r.reason === 'company_cap', r);
  G._resetBreakerCache();
  db = makeDb(Object.assign({}, SUBS));
  for (let i = 0; i < 10; i++) await gate(db, paid('growthCo'));
  const spendReads = db.reads.filter((p) => p.startsWith('ai_spend'));
  ok('ten gated calls → each spend doc read once (cached), not once per call', spendReads.length === 2, spendReads);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
