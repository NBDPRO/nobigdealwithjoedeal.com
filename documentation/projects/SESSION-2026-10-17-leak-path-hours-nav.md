# 2026-10-17 — homeowner-site review: leak path, hours, nav

Jo asked for a collaborative review of the live site (as a homeowner with a
leaking roof and as a competitor), the ten reference sites he collected, and a
comparison with Grok. Nothing was built until Jo approved the list below.

## What was verified live (not trusted from the brief)

- **Reviews render** (5.0, 31 reviews, 4 quotes). The "reviews may be blank"
  concern was stale — the Places fix landed in #1545.
- **IKO is not a gap.** The ROOFPRO application is pending; the site must not
  claim it until Jo has written confirmation. Left off the homepage on purpose.
- **Emergency tarping was buried**: one link in a 27-item Services dropdown, and
  the homepage never said "24/7" or "active leak".
- **Hours contradicted themselves**: footers said `Mon–Sat 7AM–6PM` on ~30
  pages while the tarping page promised same-day, 7 days. Jo's answer: he
  answers leaks 24/7 and does same-day tarping when daylight/weather allow.
- **Nav was ~37 links** (desktop dropdown 27 + 10 top-level; mobile drawer 37).
- Mobile hero is fine (a half-faded screenshot was just the fade-in).

## Where the leads actually come from (CRM `lead_sources`, 180 days, counts only)

Thumbtack 119 (16 won / 9 lost, 94 open) · Door Knock 65 (0 won, 63 open) ·
Online 16 · Yelp 13 (7 won / 3 lost) · Direct 12 (6 won / 5 lost) · Other 10 ·
Referral 4 · Website Cal.com 3 · Website contact form 2.
**The homepage form tagged ~5 leads in six months.** Source tags are hand-entered
and the Thumbtack feed has only run since ~2026-08-16, so treat it as directional.
Consequences: the site's job is converting people who already found Jo
elsewhere (trust, prices, one-tap call), not form completion — so a short "leak
form" was dropped from the plan. The 94 open Thumbtack and 63 open Door Knock
leads are a CRM follow-up/hygiene question, not a website one.

## Reference sites (ideas, not copies)

Fits a one-man roofer: VT Web Marketing (hours + a named human in the closing
CTA); MakerTrax's "built by a working shop" — but only for the later NBD Pro
pitch, on `/pro`. Traps: BugIt/Taskivator's confirm-before-filing flow and
PermitPull's free-check-then-paid-report gate (they sell software; a leaking-roof
visitor will not approve steps). Several of the references shipped their own
credibility bugs (MakerTrax placeholder testimonial, DraftTwo "0+" stats,
Promptaholics' three different prompt counts) — a reminder to keep every number
on this site checkable. Wellproof would not load for either fetch.

## Grok comparison

Grok (fresh grok.com chat, no repo access, given my findings) agreed on the
leak path, hours, form and nav and said skip IKO / new pages / NBD Pro on the
homeowner site. Two of its claims did not survive checking: a "Leak right now?
Call Joe" line on the storm-damage page (not in `docs/`) and an NBD Pro "free for
10 leads a month" offer (the real pricing page lists a free tier forever, Starter
$99, Team $149, Growth $299). Jo's own Grok audit was not located — compare when
he pastes it.

## What shipped (this PR)

1. Leak block in the homepage hero — "Water coming in? Call or text Joe, 24/7",
   one tap to call. On phones it replaces the duplicate "Rather talk?" line (the
   sticky Call/Text bar still covers non-leak callers).
2. Hours: every `Mon–Sat 7AM–6PM` footer/contact block now adds "Active leaks:
   call or text 24/7" (31 files + the `footer-extended` partial). Schema
   `openingHoursSpecification` was deliberately **not** changed — a 24/7 spec would
   make Google show "Open 24 hours" for estimates too. `docs/pro/terms.html` keeps
   its old footer line (NBD Pro page, not the homeowner site).
3. Nav trim in `nav-standard` / `mobile-nav-standard` (restamped, plus the two
   hand-authored navs on `/` and `/the-pledge`): Services dropdown 27 → 11 with
   Emergency Tarping first; Free Tools collapses to one link; Service Areas and Blog
   leave the top bar (still in the footer and the mobile drawer's Company group
   keeps Service Areas). Mobile drawer opens with a one-tap "Active leak? Call or
   text Joe 24/7" row. `nav-blog`, `nav-tool` and `nav-microsite` are untouched.

Gotcha recorded: `nbd-mobile.css` forces `a[href^="tel:"]{white-space:nowrap}` at
<=380px, which made a wrapped phone link overflow its box; the leak block
overrides it with `a.hx-leak[href^="tel:"]`.

## Left for Jo

- Paste the wording below into the Yelp and Thumbtack profiles (outside the repo).
- Decide whether `/pro/terms.html`'s footer should get the leak line too.
- Visual-regression baselines for `/` will need re-blessing from CI actuals.

### Draft profile wording (Yelp / Thumbtack)

> Owner-operated — Joe is on every roof. Active leak? Call or text Joe any time,
> 24/7; same-day tarping when daylight and weather allow. Free inspections and
> written quotes Mon–Sat 7AM–6PM. GAF Certified and TAMKO Pro Gold. Fully
> insured.
