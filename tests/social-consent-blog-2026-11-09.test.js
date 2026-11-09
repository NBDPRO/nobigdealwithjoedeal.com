#!/usr/bin/env node
/**
 * Social Studio: consented jobs first, and the "new blog post" type (2026-11-09).
 * Plan: documentation/projects/CONTENT-PHOTOS-CREDENTIALS-PLAN-2026-11-09.md §2 step 3.
 *
 *   A. Consent: lead.projectConsent = { on, by, at }; only on === true counts.
 *      Consented jobs are the preferred Tuesday showcase picks, ahead of newer
 *      unconsented ones. Nothing is added to what is eligible: the ranking only
 *      reorders the jobs Social Studio could already pick.
 *   B. Blog feed: the deployed /feed.xml is parsed (the functions bundle cannot
 *      read the POSTS array under docs/); only same-site /blog/ links, newest
 *      first, entities decoded.
 *   C. Which posts get shared: live (date passed), not already shared, recent,
 *      NBD only (the blog is NBD's; another tenant never gets NBD's posts).
 *   D. The draft: kind blog_post, text only, a link to the post, status draft
 *      (socialApprovePost stays the only way to approved/scheduled), the
 *      caption filter applied, a title that trips the wording rules skipped.
 *   E. planWeeks puts a live blog post in the first Thursday slot after its date.
 *   H. The link survives every text platform (review fix 2026-11-09): X's 280
 *      characters used to cut the link off 25 of the 31 real feed posts. The
 *      title / description shrink to fit; the link and hashtags never get cut.
 *      socialApprovePost refuses a blog_post whose final message lost its link.
 *   F. Server wiring (when functions deps are installed): the feed loader is NBD
 *      only, tolerates a dead feed, skips URLs already shared.
 *   G. Wiring: client kind label, FUNCTIONS_INDEX.
 *
 * Run: node tests/social-consent-blog-2026-11-09.test.js
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
function attempt(fn) { try { return fn(); } catch (e) { return { __error: e && e.message }; } }

const L = require(path.join(ROOT, 'functions', 'social-logic.js'));
const NOW = Date.parse('2026-11-16T15:00:00Z'); // a Monday
const fn = (name) => (typeof L[name] === 'function' ? L[name] : () => { throw new Error('L.' + name + ' missing'); });

(async () => {
  // ── A. consent ─────────────────────────────────────────────────────────
  console.log('A. consent');
  const has = fn('hasProjectConsent');
  ok('consent on: { on: true } counts', attempt(() => has({ projectConsent: { on: true, by: 'u1', at: { seconds: 1 } } })) === true);
  ok('consent off / missing / truthy-but-not-true does not count',
    attempt(() => [has({ projectConsent: { on: false } }), has({}), has(null), has({ projectConsent: { on: 'yes' } }), has({ projectConsent: true }), has({ consentOnFile: true })].every((v) => v === false)));

  const rank = fn('rankShowcaseJobs');
  const ranked = attempt(() => rank([
    { leadId: 'new1', consented: false }, { leadId: 'new2', consented: false },
    { leadId: 'oldC', consented: true }, { leadId: 'new3' }, { leadId: 'oldC2', consented: true },
  ]));
  ok('rank: consented first, order kept within each group (stable)', Array.isArray(ranked) && ranked.map((j) => j.leadId).join() === 'oldC,oldC2,new1,new2,new3', JSON.stringify(ranked));
  ok('rank: never adds or drops a job', Array.isArray(ranked) && ranked.length === 5);
  ok('rank: does not mutate its input', attempt(() => { const a = [{ leadId: 'x' }, { leadId: 'y', consented: true }]; rank(a); return a[0].leadId === 'x'; }) === true);

  const plan = attempt(() => L.planWeeks({ weeks: 1, platforms: ['facebook'], startMs: NOW, seed: 1,
    jobs: [{ leadId: 'newer', facts: { town: 'Union', state: 'KY' }, format: 'single', consented: false },
      { leadId: 'consented', facts: { town: 'Florence', state: 'KY' }, format: 'single', consented: true }] }));
  const tue = Array.isArray(plan) ? plan.find((p) => p.kind === 'job_showcase') : null;
  ok('planWeeks: the Tuesday showcase picks the consented job over a newer unconsented one', tue && tue.leadId === 'consented', JSON.stringify(tue));
  const planNoConsent = L.planWeeks({ weeks: 1, platforms: ['facebook'], startMs: NOW, seed: 1, jobs: [{ leadId: 'only', facts: {}, format: 'single' }] });
  ok('planWeeks: with no consented job, the existing eligibility still applies (not narrowed)', planNoConsent.some((p) => p.kind === 'job_showcase' && p.leadId === 'only'));

  // ── B. feed parsing ────────────────────────────────────────────────────
  console.log('B. feed parsing');
  const item = (t, link, date, desc) => `  <item>\n    <title>${t}</title>\n    <link>${link}</link>\n    <guid isPermaLink="true">${link}</guid>\n    <pubDate>${date}</pubDate>\n    <description>${desc}</description>\n  </item>`;
  const FEED = `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel>\n<title>The No Big Deal Blog</title>\n`
    + [
      item('Ice Dams: What They Are &amp; How to Stop Them', 'https://nobigdealwithjoedeal.com/blog/ice-dams', 'Tue, 10 Nov 2026 12:00:00 GMT', 'Why the eaves freeze, and the fix that lasts.'),
      item('Old Post', 'https://nobigdealwithjoedeal.com/blog/old-post', 'Fri, 16 Oct 2026 12:00:00 GMT', 'Older.'),
      item('Offsite', 'https://evil.example.com/blog/x', 'Tue, 10 Nov 2026 12:00:00 GMT', 'Not ours.'),
      item('Look-alike host', 'https://nobigdealwithjoedeal.com.evil.example/blog/x', 'Tue, 10 Nov 2026 12:00:00 GMT', 'Not ours.'),
      item('Future Post', 'https://nobigdealwithjoedeal.com/blog/future', 'Tue, 17 Nov 2026 12:00:00 GMT', 'Not yet.'),
      item('We Handle Your Insurance Claim For You', 'https://nobigdealwithjoedeal.com/blog/claim-help', 'Thu, 12 Nov 2026 12:00:00 GMT', 'Claim talk.'),
    ].join('\n') + '\n</channel></rss>\n';
  const items = attempt(() => fn('parseBlogFeed')(FEED));
  ok('parse: same-site /blog/ links only (offsite and look-alike hosts dropped)', Array.isArray(items) && items.length === 4 && items.every((i) => i.url.startsWith('https://nobigdealwithjoedeal.com/blog/')), JSON.stringify(items));
  ok('parse: newest first', Array.isArray(items) && items[0].url.endsWith('/future') && items[items.length - 1].url.endsWith('/old-post'));
  ok('parse: entities decoded, date read', Array.isArray(items) && items.some((i) => i.title === 'Ice Dams: What They Are & How to Stop Them' && i.publishedMs === Date.parse('2026-11-10T12:00:00Z')));
  ok('parse: garbage in, empty list out', attempt(() => fn('parseBlogFeed')('not xml')).length === 0 && attempt(() => fn('parseBlogFeed')(null)).length === 0);
  ok('parse: the real committed feed parses (positive control)', attempt(() => fn('parseBlogFeed')(read('docs/feed.xml')).length) >= 10);

  // ── C. which posts ─────────────────────────────────────────────────────
  console.log('C. which posts get shared');
  const pickShares = fn('blogPostsToShare');
  const shares = attempt(() => pickShares(items, { nowMs: NOW, sharedUrls: new Set() }));
  const urls = Array.isArray(shares) ? shares.map((s) => s.url.replace(/^.*\/blog\//, '')) : [];
  ok('only posts whose date has passed (the 11-17 post waits)', Array.isArray(shares) && !urls.includes('future'), urls.join());
  ok('recent posts only (a month-old post is not "new")', Array.isArray(shares) && !urls.includes('old-post'), urls.join());
  ok('a live, recent, unshared post is picked', urls.includes('ice-dams'), urls.join());
  const again = attempt(() => pickShares(items, { nowMs: NOW, sharedUrls: new Set(['https://nobigdealwithjoedeal.com/blog/ice-dams']) }));
  ok('a post already shared is not shared again', Array.isArray(again) && !again.some((s) => s.url.endsWith('/ice-dams')));

  // ── D. the draft ───────────────────────────────────────────────────────
  console.log('D. the draft');
  ok('KINDS names the new type', L.KINDS && L.KINDS.blog_post === 'New blog post');
  const ice = Array.isArray(items) ? items.find((i) => i.url.endsWith('/ice-dams')) : null;
  const draft = attempt(() => fn('buildBlogPostDraft')({ post: ice, platform: 'facebook' }));
  ok('draft: kind blog_post, text only, status draft, no lead', draft && draft.kind === 'blog_post' && draft.format === 'text' && draft.status === 'draft' && draft.sourceLeadId === null && Array.isArray(draft.media) && draft.media.length === 0, JSON.stringify(draft));
  ok('draft: links the post and names it', draft && typeof draft.caption === 'string' && draft.caption.includes('https://nobigdealwithjoedeal.com/blog/ice-dams') && draft.caption.includes('Ice Dams') && draft.blogUrl === 'https://nobigdealwithjoedeal.com/blog/ice-dams');
  ok('draft: never approved or scheduled here (socialApprovePost is the only path)', draft && draft.status === 'draft' && !('approvedAt' in draft) && !('approvedBy' in draft) && !draft.scheduledAt);
  ok('draft: the caption passes the filter as written', draft && typeof draft.caption === 'string' && L.cleanCaption(draft.caption, {}).dropped.length === 0);
  ok('draft: hashtags present and clean', draft && Array.isArray(draft.hashtags) && draft.hashtags.length > 0 && draft.hashtags.every((h) => /^#[A-Za-z0-9_]+$/.test(h)));
  const claimItem = Array.isArray(items) ? items.find((i) => i.url.endsWith('/claim-help')) : null;
  ok('draft: a title that trips the KY / social wording rules is skipped (null), never posted', attempt(() => fn('buildBlogPostDraft')({ post: claimItem, platform: 'facebook' })) === null);
  ok('draft: a media-only platform (Instagram) gets no text-only blog draft', attempt(() => fn('buildBlogPostDraft')({ post: ice, platform: 'instagram' })) === null);
  ok('draft: an offsite URL is refused even if passed in directly', attempt(() => fn('buildBlogPostDraft')({ post: { title: 'X', url: 'https://evil.example.com/blog/x', publishedMs: NOW - 1 }, platform: 'facebook' })) === null);

  // ── E. planWeeks with blog posts ───────────────────────────────────────
  console.log('E. planWeeks with blog posts');
  const p2 = attempt(() => L.planWeeks({ weeks: 2, platforms: ['facebook', 'instagram'], startMs: NOW, seed: 2, blogPosts: [ice] }));
  const blogs = Array.isArray(p2) ? p2.filter((p) => p.kind === 'blog_post') : [];
  ok('plan: one blog_post proposal per text platform (Facebook yes, Instagram no)', blogs.length === 1 && blogs[0].platform === 'facebook', JSON.stringify(blogs));
  const thu = blogs[0] ? L.zonedYmd(blogs[0].scheduledAtMs) : null;
  ok('plan: it takes the first Thursday slot (2026-11-19), after its date', thu && thu.dow === 4 && thu.m === 11 && thu.d === 19 && blogs[0].scheduledAtMs > ice.publishedMs, JSON.stringify(thu));
  ok('plan: the blog proposal carries its URL for the dedupe', blogs[0] && blogs[0].blogUrl === ice.url);
  ok('plan: the other Thursday stays a tip / storm PSA', Array.isArray(p2) && p2.some((p) => (p.kind === 'tip' || p.kind === 'storm_psa') && L.zonedYmd(p.scheduledAtMs).d === 26));
  const fut = Array.isArray(items) ? items.find((i) => i.url.endsWith('/future')) : null;
  const p3 = attempt(() => L.planWeeks({ weeks: 2, platforms: ['facebook'], startMs: NOW, seed: 2, blogPosts: [fut] }));
  const futBlog = Array.isArray(p3) ? p3.find((p) => p.kind === 'blog_post') : null;
  ok('plan: a post handed in before its date is never scheduled before that date', !futBlog || futBlog.scheduledAtMs >= fut.publishedMs);
  const p4 = attempt(() => L.planWeeks({ weeks: 1, platforms: ['facebook'], startMs: NOW, seed: 2, blogPosts: [claimItem] }));
  ok('plan: a post whose title trips the rules is left out of the plan', Array.isArray(p4) && !p4.some((p) => p.kind === 'blog_post'));

  // ── H. the link survives every text platform ───────────────────────────
  console.log('H. the link survives');
  const TEXT_PLATFORMS = Object.keys(L.PLATFORMS).filter((p) => !L.PLATFORMS[p].needsMedia);
  ok('positive control: X is a text platform with a 280 limit', TEXT_PLATFORMS.includes('x') && L.PLATFORMS.x.maxCaption === 280);
  const realItems = attempt(() => fn('parseBlogFeed')(read('docs/feed.xml'))) || [];
  const lost = [];
  let xDrafts = 0, fbDrafts = 0;
  for (const it of (Array.isArray(realItems) ? realItems : [])) {
    for (const p of TEXT_PLATFORMS) {
      const d = attempt(() => fn('buildBlogPostDraft')({ post: it, platform: p }));
      if (!d || d.__error) { if (d && d.__error) lost.push(p + ':' + it.url + ' threw ' + d.__error); continue; }
      if (p === 'x') xDrafts++;
      if (p === 'facebook') fbDrafts++;
      const msg = L.composeMessage(d);
      if (!msg.includes(it.url) || msg.length > L.PLATFORMS[p].maxCaption || !d.caption.includes(it.url)) lost.push(p + ':' + it.url.replace(/^.*\/blog\//, ''));
    }
  }
  ok('every real feed post on every text platform: the final message carries the full link', lost.length === 0, lost.length + ' lost, e.g. ' + lost.slice(0, 4).join(' | '));
  ok('X gets a draft for every post Facebook does (no silent skip for length)', xDrafts > 0 && xDrafts === fbDrafts, xDrafts + ' on X, ' + fbDrafts + ' on Facebook, of ' + realItems.length);
  const longPost = { title: 'A Very Long Title About Roof Ventilation And Attic Moisture And Why Your Shingles Curl Early In Northern Kentucky Winters And What To Do About It Before Spring Arrives Again This Year', url: 'https://nobigdealwithjoedeal.com/blog/a-very-long-slug-about-roof-ventilation-and-attic-moisture-and-curling-shingles-in-northern-kentucky-winters', description: 'Ventilation matters. '.repeat(18).trim(), publishedMs: NOW - 86400000 };
  const xLong = attempt(() => fn('buildBlogPostDraft')({ post: longPost, platform: 'x' }));
  ok('X, a long title + long slug: link intact, message within 280', xLong && !xLong.__error && L.composeMessage(xLong).includes(longPost.url) && L.composeMessage(xLong).length <= 280, xLong && JSON.stringify(xLong.caption));
  ok('X, a long title is shortened on a word with an ellipsis, not mid-word', xLong && /New on the blog: A Very Long Title[^\n]*\u2026/.test(xLong.caption || ''), xLong && xLong.caption);
  const fbIce = attempt(() => fn('buildBlogPostDraft')({ post: ice, platform: 'facebook' }));
  ok('Facebook keeps the description when it fits', fbIce && /Why the eaves freeze/.test(fbIce.caption || ''));
  const pAll = attempt(() => L.planWeeks({ weeks: 4, platforms: TEXT_PLATFORMS, startMs: NOW, seed: 3, blogPosts: [longPost, ice] }));
  const pBlog = Array.isArray(pAll) ? pAll.filter((p) => p.kind === 'blog_post') : [];
  ok('planWeeks on every text platform (X included): each blog row\'s final message carries its blogUrl', pBlog.length === TEXT_PLATFORMS.length * 2 && pBlog.every((p) => L.composeMessage(p).includes(p.blogUrl) && L.composeMessage(p).length <= L.PLATFORMS[p.platform].maxCaption), pBlog.filter((p) => !L.composeMessage(p).includes(p.blogUrl)).map((p) => p.platform).join() + ' / ' + pBlog.length);
  const blk = fn('blogLinkBlocker');
  ok('approval gate: a blog_post whose message still has its link passes', attempt(() => blk({ kind: 'blog_post', platform: 'x', blogUrl: ice.url, caption: 'New. Read it here: ' + ice.url, hashtags: ['#rooftips'] })) === null);
  ok('approval gate: a blog_post whose link was edited out is refused', typeof attempt(() => blk({ kind: 'blog_post', platform: 'facebook', blogUrl: ice.url, caption: 'New on the blog: Ice Dams.', hashtags: [] })) === 'string');
  ok('approval gate: a blog_post with no blogUrl is refused', typeof attempt(() => blk({ kind: 'blog_post', platform: 'facebook', caption: 'x', hashtags: [] })) === 'string');
  ok('approval gate: other kinds are untouched', attempt(() => blk({ kind: 'tip', platform: 'x', caption: 'Check your flashing.', hashtags: [] })) === null);

  // ── F. server wiring ───────────────────────────────────────────────────
  console.log('F. server');
  let SS = null;
  try { require.resolve('firebase-functions/v2/https', { paths: [path.join(ROOT, 'functions')] }); SS = require(path.join(ROOT, 'functions', 'social-studio.js'))._test; } catch (_) { SS = null; }
  if (!SS) {
    ok('functions deps unavailable here — F skipped (CI installs functions deps)', true);
  } else {
    const NBD = SS.NBD_OWNER_UID;
    const fakeFetch = (body, okFlag) => { const calls = []; const f = async (url) => { calls.push(url); if (body instanceof Error) throw body; return { ok: okFlag !== false, status: okFlag === false ? 500 : 200, text: async () => body }; }; f.calls = calls; return f; };
    // Dedupe asks only for the candidate URLs (blogUrl in [...]), so it never
    // misses an old share behind a row cap.
    const fakeDb = (shared, seen) => ({
      collection: () => ({ doc: () => ({ collection: () => ({ where: (field, op, val) => {
        if (seen) seen.push([field, op, val]);
        const rows = shared.filter((d) => field === 'blogUrl' && op === 'in' && Array.isArray(val) && val.includes(d.blogUrl));
        return { get: async () => ({ forEach: (cb) => rows.forEach((d) => cb({ data: () => d })) }) };
      } }) }) }),
    });
    const f1 = fakeFetch(FEED);
    const nbd = await SS.loadBlogShares(fakeDb([]), NBD, NOW, f1).catch((e) => ({ __error: e.message }));
    ok('NBD: the deployed feed is read and the live post comes back', Array.isArray(nbd) && nbd.some((s) => s.url.endsWith('/ice-dams')), JSON.stringify(nbd));
    ok('NBD: it reads the site\'s own /feed.xml', f1.calls.length === 1 && f1.calls[0] === 'https://nobigdealwithjoedeal.com/feed.xml', f1.calls.join());
    const f2 = fakeFetch(FEED);
    const other = await SS.loadBlogShares(fakeDb([]), 'some-other-company', NOW, f2);
    ok('another tenant: no NBD blog posts, the feed is not even fetched', Array.isArray(other) && other.length === 0 && f2.calls.length === 0);
    const dead = await SS.loadBlogShares(fakeDb([]), NBD, NOW, fakeFetch(new Error('network down'))).catch((e) => ({ __error: e.message }));
    ok('a dead feed means no blog posts, never a failed plan', Array.isArray(dead) && dead.length === 0);
    const http500 = await SS.loadBlogShares(fakeDb([]), NBD, NOW, fakeFetch(FEED, false));
    ok('an HTTP error means no blog posts', Array.isArray(http500) && http500.length === 0);
    const dup = await SS.loadBlogShares(fakeDb([{ kind: 'blog_post', blogUrl: 'https://nobigdealwithjoedeal.com/blog/ice-dams', status: 'posted' }]), NBD, NOW, fakeFetch(FEED));
    ok('a post already drafted / posted is not shared again', Array.isArray(dup) && !dup.some((s) => s.url.endsWith('/ice-dams')));
    const cancelled = await SS.loadBlogShares(fakeDb([{ kind: 'blog_post', blogUrl: 'https://nobigdealwithjoedeal.com/blog/ice-dams', status: 'cancelled' }]), NBD, NOW, fakeFetch(FEED));
    const seen = [];
    const many = Array.from({ length: 600 }, (_, i) => ({ kind: 'blog_post', blogUrl: 'https://nobigdealwithjoedeal.com/blog/filler-' + i, status: 'posted' }));
    const deep = await SS.loadBlogShares(fakeDb(many.concat([{ kind: 'blog_post', blogUrl: 'https://nobigdealwithjoedeal.com/blog/ice-dams', status: 'posted' }]), seen), NBD, NOW, fakeFetch(FEED));
    ok('dedupe asks for the candidate URLs only (blogUrl in [...], at most 30), so 600 older shares cannot hide one', Array.isArray(deep) && !deep.some((s) => s.url.endsWith('/ice-dams')) && seen.length === 1 && seen[0][0] === 'blogUrl' && seen[0][1] === 'in' && seen[0][2].length <= 30, JSON.stringify(seen.map((x) => x.slice(0, 2))));
    ok('a cancelled share does not block a fresh one', Array.isArray(cancelled) && cancelled.some((s) => s.url.endsWith('/ice-dams')));
  }
  const src = read('functions/social-studio.js');
  ok('eligibleJobs ranks with the consent helper (consented first, nothing added)', /L\.hasProjectConsent\(/.test(src) && /L\.rankShowcaseJobs\(/.test(src));
  ok('socialPlanWeeks hands blog posts to planWeeks and stores blogUrl on the draft', /L\.planWeeks\(\{[^\n]*\bblogPosts\b/.test(src) && /blogUrl/.test(src));

  ok('socialApprovePost runs the blog link gate on the final caption + hashtags', /L\.blogLinkBlocker\(\{[^\n]*caption[^\n]*hashtags/.test(src));
  ok('dedupe no longer caps at 500 unordered rows', !/where\('kind', '==', 'blog_post'\)\.limit\(500\)/.test(src));
  const rules = read('firestore.rules');
  const spBlock = rules.slice(rules.indexOf('match /social_posts/{postId}'), rules.indexOf('match /social_posts/{postId}') + 1200);
  ok('rules: a client cannot create a social post carrying blogUrl', /allow create:[\s\S]*?hasAny\(\[[^\]]*'blogUrl'/.test(spBlock));
  ok('rules: a client cannot change blogUrl on update', /allow update:[\s\S]*?didNotChange\(\[[^\]]*'blogUrl'/.test(spBlock));

  // ── G. wiring ──────────────────────────────────────────────────────────
  console.log('G. wiring');
  ok('client kind label for blog_post', /blog_post:\s*'New blog post'/.test(read('docs/pro/js/social-studio-logic.js')));
  ok('FUNCTIONS_INDEX: socialPlanWeeks names consented jobs and blog posts', /`socialPlanWeeks`[^\n]*consent[^\n]*blog/i.test(read('functions/FUNCTIONS_INDEX.md')));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
