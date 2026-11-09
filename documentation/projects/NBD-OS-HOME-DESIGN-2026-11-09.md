# NBD OS Home: widgets, apps, a sortable board, and the "uncommon" lane (design, 2026-11-09)

Design note for Jo. Read-only recon at HEAD c178a7818. It merges the design brief, the adversarial critique of that brief (every correction applied), and the ranked macOS / Linux / web-desktop research. Parent plan: [NBD-OS-PLAN-2026-11-06](NBD-OS-PLAN-2026-11-06.md). Related: [CRM-STYLE-D5-BENTO-BOARD-2026-10-12](CRM-STYLE-D5-BENTO-BOARD-2026-10-12.md), [DAILY-SUCCESS-BUSINESS-TILE-2026-10-23](DAILY-SUCCESS-BUSINESS-TILE-2026-10-23.md), [DAILY-SUCCESS-EOD-REVIEW-2026-10-22](DAILY-SUCCESS-EOD-REVIEW-2026-10-22.md), [VISUAL-AUDIT-LAYOUTS-2026-10-19](../audit/VISUAL-AUDIT-LAYOUTS-2026-10-19.md), [CHARACTER-STYLE-BAR-2026-10-25](CHARACTER-STYLE-BAR-2026-10-25.md), [DESIGN.md](../../DESIGN.md).

## Update 2026-11-09 (evening): what shipped in P2

P2 is built on branch `os-p2` (on `os-p1`), dark behind `osLayout`; the session note is [SESSION-2026-11-09-nbd-os-p2](SESSION-2026-11-09-nbd-os-p2.md). Where it differs from §6 and §8 below:

- **Smart Stack default:** Shutdown *replaces* Coach (`['upnext', 'storm', 'daily', 'shutdown']`). The P1 default already held four cards, so "add Shutdown when a stack has room" never applied. It reaches new stacks and saved stacks with no valid card.
- **"In a home" (§6.3)** covers the home surfaces: the widgets, the Notification Center, toasts, Peek, the Recap and the Coach AI line. Phone apps opened from the home (Pipeline, Money) still show money and names.
- **The Coach AI line** is opt-in per company (`coachAiEnabled`), 3 a day per user and 60 per company; viewers may ask for it (`read-paid`), so a viewer can spend the company cap.
- **Team** counts doors, appointments set, estimates sent and deals in the company's time zone (`companyProfile.timeZone`), weeks from Monday, every 30 minutes; dark behind `LEADERBOARD_AGGREGATE_ENABLED`, whose dry run counts one company per run.
- **P1 debt paid:** `bento.js` now builds its math from `board-logic.js`; the goals editor exists (large Daily Success widget).

## Update 2026-11-09 (later): what shipped in P1

P1 is built on branch `os-p1`, dark behind `osLayout`; the session note is [SESSION-2026-11-09-nbd-os-p1](SESSION-2026-11-09-nbd-os-p1.md). Where it differs from §5 and §8 below:

- **Daily Success goals are done-vs-left honest.** Only doors are shown against a goal ("Doors 4 of 40"), because nothing counts calls or follow-ups *done*; `nbd_today_summary` holds what is *left*. `callsPerDay` / `followUpsPerDay` are stored and rules-validated but unread, and no screen writes `settings/goals` yet (console only). The doors count needs, and now has, a knocks `(userId ASC, createdAt ASC)` index.
- **Closes this week** uses the CRM's `closes-week-logic.js` rank (the `closesweek` bundle), not a new one.
- **Shutdown's touch signal** is a human touch on the rep's own lead from stamps only a person writes (contact, "I replied", a stage entry by this uid, a task done today, a knock lead today); `updatedAt` and server stamps are not touches.
- **The urgency ring** counts only the member's own (or unowned) new leads.
- **`board-logic.js` is a lifted copy beside `bento.js`, not the re-export §4 and §8 asked for.** A parity test pins them; making `bento.js` call it is follow-up debt.
- **Company home rules** bound the lists by type and size (24) only; item shape is checked on the client.
- **The laptop Edit Home bar** is its own row under the board, not sticky over it.
- **Still open:** the real-iPhone pass for phone drag and for page 1's vertical scroll inside the pager (§3.3), and a second bounded timer (the OS mount's claims poll) beside the one ticker of §7.

Jo's ask (2026-11-09): "I want to do things that are uncommon, unthought of, extremely unique, but also extremely productive, powerful, time saving, and more", drawing on Linux desktops and macOS.

## 1. TL;DR

- **NBD OS has no widget system today.** The desk "widget column" and the phone "widget row" are a hard-coded clock plus two buttons (`os.js:463-469`, `os.js:766-771`). The plan's Today widget was never built (`NBD-OS-PLAN:190,215`).
- **No new library, no boot weight.** Bento's engine (`bento.js:42-210`) is the only keyboard move/resize path among ten options measured; 31 renderers already load at boot (`widgets.js:132-843`); My Skin is already a wallpaper engine with a WCAG auto-dim.
- **Home state gets its own key, `layoutState['os-home']`, under its own 12,000-char budget.** The brief's plan to nest it in `os` could overflow and silently drop every window, icon and pin (`layout-system.js:41,146-152`). A separate key is not enough on its own: `saveUser` re-sends the whole cached `layoutState` map on every save, so it must be patched to send only changed keys (§3.5).
- **First fix an existing bug: a phone visit wipes the laptop's desk and pins** (`os.js:985`, `:1108-1111`). The phone mount never restores `desk` or `pins`, so the next save writes `desk:0, pins:[]`. The fix copies the desk restore (`os.js:546`) into the phone mount, with the failing test written first.
- **Daily Success and Coach are rules-first; code puts every number on screen.** No default goals, no paid streak repair. The optional AI line is server-built, about $0.09 per rep per month at the cap of 3 lines a day (estimate), and post-checked so it can't state a number it wasn't given.
- **The uncommon lane is the differentiator:** a Smart Stack that knows the rep's day, a Shutdown ritual that closes the loop on every lead touched today, job-phase Activities, a KRunner-style action runner and an urgency ring for new inbound leads, all on data the CRM already holds.

## 2. What exists and what we reuse (corrected)

| Asset | Where (verified) | Use | Correction applied |
|---|---|---|---|
| Grid engine (`pack/sanitize/moveTo/resizeTo/cellFromPoint/describe`; 18 catalog tiles, `MAX_TILES` 24) | `NBDBentoLogic`, `bento.js:92-210`; catalog `:46-64`, `MAX_TILES` `:43` | Lift to `layouts/board-logic.js` in P1 | Tiles keyed `widgetId` (`:200`), sizes as `[w,h]` (`:46-64`); drag is off on phones (`:613`); `layout-bento` test requires `bento.js` (`:34`), so it keeps re-exporting. |
| Keyboard edit plus live region | `bento.js:584-597`, `:438` | Copy | **One model: Bento's.** Space-to-pick-up dropped. |
| 31 renderers | `widgets.js:132-843`, export `:1506-1514`, tag `dashboard.html:7430` | Per-renderer allow-list | Some read: `yardSigns` (`:546-547`), Thursday (`:920,924,977`); 16 `style="` sites; assumes `#widgetGrid` (`:1255,1530`). |
| Today plan | `NBDToday.compute/last`; `NBDTodayPlan.headline` (`today-plan.js:761,788`) | Up Next, At a Glance | Read `last()` and listen for the `nbd:today-rendered` event it already fires (`widgets.js:1500`). Don't call `compute()`: it mutates the handled-call state (`unmarkHandled`, `today-home.js:43`). `#todayPlan` exists in `dashboard.html:940` and on the desk is only hidden by CSS (`os.css:12`), so `render()` doesn't exit early in the OS. `appointmentRows` carries names (`:999`): strip them. |
| Needs-you counts | `NBDHomeAttention.lastCounts` (`home-attention.js:519`) | Counts only | Never re-query (600+300 `phone_calls`, `:445-493`). |
| DS snapshot | `dsSnapshot` (`review-logic.js:155-173`), `nbd_ds_snapshot` (`review-ui.js:118`) | Personal half | Readable by the **platform admin** only (`isAdmin()`, a cross-tenant support role, `firestore.rules:20,27`); company owners and company_admins can't read a rep's `userSettings`. `today.dk` is device-local (`app.js:144`): compare with the writer's key. Written only when DS runs; read once (`layout-system.js:650`). |
| Rep OS tips | `rep-os.js:175-203` (lazy) | Not in v1 | Canned "4-7pm" (`:37`), "3x" (`:49`), false "AI-powered" (`:3,524`). |
| Workout coach | `NBDCoach` (`workout-coach-logic.js:1055`) | Via the snapshot later | **Not on the dashboard**; sessions device-local (`app.js:292`). |
| Grounded AI template | `functions/lead-brief-logic.js:155-226` (server only, no client copy), `functions/lead-brief.js:31,91-141` | `coachLine` (P2) | `parseBrief` doesn't check numbers; we add it. Gate pattern: `aiAllowed` (`:124-133`), `takeQuota` (`:136-141`), `recordAiSpend` (`:104`). |
| Wallpaper engine | `my-skin.js:1-31,888-919`, `my-skin-logic.js:24-52,533-557`, `my-skin-company.js` | All OS wallpaper | Lazy (`my-skin-boot.js:16-17`): call `NBDMySkinBoot.load()` first. `accentCheck` is `:562-571`. |
| Company default | `settings/layout` (`layout-system.js:733-759`), `cleanDefaultWidgets` (`:166-176`) | Starter home | Arrays of ≤24 only, ≤4,000 chars each (`:170-173`); rules `hasOnly` (`firestore.rules:3324`), bound only `bento` (`:3330-3334`). |
| Lazy deps | `needs` (`layout-system.js:335`, ≤6 paths `:97`, `needs.css` `:73,457`) | All new code | `os` uses 2 of 6 today. |
| Control Center hook | `registerControl` (`system.js:626-632`) | Wallpaper, Edit Home | |

**Apps the sidebar can't express.** `readNav` takes only `[data-action="goTo"]` (`system-logic.js:168`) with a `#view-<id>` (`os.js:58-63`). Left out: Daily Success and How To (`windowOpen`, `dashboard.html:849,881`), Maps (**`data-action="call"`** `goToD2DFromMaps`, `:820`), Roof Rep and Social Studio (`<a href>`, `:828,855`). Daily Success can't be framed (`X-Frame-Options: DENY`, `firebase.json:140`; `frame-ancestors 'none'`, `:147`), so it opens in the same tab like `openDailyTracker` (`widgets.js:1550`).

**Role gating hides nav items. It doesn't remove them.** `requiresNav` has to reuse `readNav`'s hidden test (`hidden`, `.dn`, `display:none`, `aria-hidden`; `system-logic.js:179-180`), and has to re-check it on every paint because claims arrive late.

## 3. The model

### 3.1 Registry (new lazy `os/home-logic.js` data plus `os/home.js` renderers)

```
{ id, title, about, icon, cat,
  kind: 'widget'|'native'|'shortcut'|'app'|'stack',
  widget?: 'daily-floors',        // allow-listed NBDWidgets id
  action?: {dataAction, target, fn},// kind 'app': dispatched via the sidebar's own data-action
  sizes:['s','m','l'], def:'m',
  refresh:'show'|'minute'|'event:<name>',
  bundle?:'oscoach',  reads:0,      // declared read cost, asserted in tests
  requiresNav?:'crm', flag?,
  config?:[{key,type:'enum'|'bool',options}],
  states?:{warning, critical},      // threshold tones (Waybar `states`)
  render(el,size,cfg,ctx), unmount() }
```

`kind:'app'` dispatches through the sidebar's own `data-action`, never `window.open`, so the demo's tool-page remap still applies. Every mount is wrapped in `safe()` (`os.js:51`): a widget that throws shows "Couldn't load · Retry" and the rest keeps working (GNOME: `disable()` undoes `enable()`).

### 3.2 Sizes

| Size | Phone (4-col grid; `PER_PAGE` is **20 cells**, `os.js:753`) | Laptop (4-col, 160px rows) | Content |
|---|---|---|---|
| S | 2×2 cells | 1×1 | one number and a label |
| M | 4×2 | 2×1 | up to 3 rows |
| L | 4×4 | 2×2 | a list with actions |

Each size lays out differently via container queries (HIG: never stretch a small widget). Floors hold: no text under 11px, 44px targets (`DESIGN.md:235`); a copy-budget test caps headlines at about 32 characters (elementary text HIG).

### 3.3 Pages and stacks

- **Phone:** `phonePaint` (`os.js:761-791`) rewrites the phone markup at `:787` and has 9 callers (`:826`…`:1135`). Anything placed outside `.os-p-pages` shows on every page and shrinks the pager (`os.css:194-196`, `flex:1`), so "top of page 1 but outside `phonePaint`" is not possible. Pick one (Q7): **(a)** widgets inside page 1, with a keyed reconcile inside `phonePaint` so a repaint doesn't remount them; or **(b)** a block above all pages, visible on every page. *Default:* (a). Page height is fixed before drag work, or a tall block nests vertical scroll in the `scroll-snap-type:x` pager (`os.css:196`).
- **Laptop:** P0 turns the 220px column into an ordered list; P1 makes it a 2D board through `board-logic` that collapses to one column below 1100px instead of hiding (`os.css:163`).
- **Stacks (P1):** up to 4 children, counted against the cap, chosen by deterministic rules with prev/next and "Why this?", never auto-rotated (§6.1).

### 3.4 Edit mode

- **Ways in:** long-press (550 ms, `os.js:936-946`; the selector widens beyond `.os-p-icon`/`.os-bar`, `:937-938`), a Control Center "Edit Home" tile, or Spotlight "Edit home screen".
- **Touch:** tap-pick then tap-place is the single-pointer path (WCAG 2.5.7), reusing `editTap` (`os.js:880-897`). Hold-and-drag waits for P1 (pointer capture, `touch-action:none` set before `pointerdown`). Widgets get `-webkit-touch-callout:none; user-select:none` (today only icons and the bar, `os.css:207,236`).
- **Keyboard:** Bento's mapping. A live-region line announces each change ("Coach, medium, position 2"), and focus returns to the moved item.
- **Chrome:** an S/M/L chip, a ⋯ menu (Size, Settings, Remove), and in P1 a laptop corner grip (`os.js:648` pattern).
- **Add sheet:** native `<dialog>.showModal()` grouped by `cat`, live previews from sample counts, "Add" drops into the first free slot (no gloved dragging), filtered by the `readNav` hidden test.
- **Motion:** no jiggle, stack, slideshow or transition motion under `prefers-reduced-motion` *or* `data-motion="reduce"` (`DESIGN.md:98-99,199`).

### 3.5 Persistence

**User-wide (Firestore)**
- Key `layoutState['os-home']` (`isId` allows the hyphen), with its own 12,000-char budget:
  ```
  { v:1, phone:[{id, s, cfg?, items?}], desk:[{id, s, cfg?} | {id,x,y,w,h,cfg?}], wp:{phone:imageId|null, desk:imageId|null},
    acts?:[/* P2, ≤4 activities, each its own phone/desk/wp/focus */] }
  ```
- Caps: 12 items per surface in P0, 24 from P1; `cfg` enum/bool only, ≤64 B; stack children count. A max-fill test asserts the whole key ≤12,000 chars.
- Phone and desk are separate arrangements (Homarr, Plasma per-resolution).
- **A separate key does not isolate it.** `saveUser` re-sends the whole cached `layoutState` map on every save (`layout-system.js:694`, `:717`, `setDoc` with `merge:true`), and `hydrate` is a one-shot read with no listener. A stale tab or device that saves OS windows therefore overwrites a newer `os-home` written elsewhere: the same bug class as the phone wipe, across devices. `saveUser` must send only the patched keys, with a failing test first.

**Device-only** (`nbd_` localStorage, wiped at sign-out, like DND and button style, `system.js:39,60-62`): slideshow pause, last stack page, today's dismissed coach rules.

**Company:** `defaultWidgets['os-phone']` and `['os-desk']` as **arrays** (so `cleanDefaultWidgets` keeps them), each rule-bounded to ≤24, plus `homeLocked` added to `hasOnly` (`firestore.rules:3324`) with an emulator test. Precedence: company lock > own home > company default > built-in. `homeLocked` precedence is new code; `layout-system.js:192-221` (which resolves the layout id only) is the pattern to follow, not code to reuse.

### 3.6 Wallpaper

- **Sources:** built-in time-of-day gradients built with `color-mix` from theme tokens only (`DESIGN.md:225-226`), no new hues since the palette is locked (dawn/day/dusk/night, picked by the clock tick, 0 image bytes; Sunlight forces day; macOS dynamic wallpaper, GNOME time-of-day XML; `.os-desk` has no background today, `os.css:14-15`); My Skin per-theme images read with `getBlob` into blob: URLs (`my-skin.js:15-22`), with per-surface overrides storing **image ids only**; theme overlays as the "animated" choice, hidden by a picture by default ([CRM-STYLE-INTEGRATION-ROADMAP-2026-10-11](CRM-STYLE-INTEGRATION-ROADMAP-2026-10-11.md) :157). A company-enforced background wins.
- **Entry:** the Control Center tile and "Wallpaper…" in edit mode both call `NBDMySkinBoot.load()`, then open Settings › My Skin (`dashboard.html:3726,3755`).
- **Legibility:** one pre-dimmed layer (`my-skin-logic.js:533-557`) plus a token glass per widget (`--s` at alpha, `--ui-elev-*`), **no live `backdrop-filter` per card**. This closes the open scrim row (VISUAL-AUDIT :155,176-178).
- **Brand:** tokens only (`DESIGN.md:58-66`); one filled orange per region (`:227`), and New lead already is one (`os.js:466,769`), so widget buttons stay quiet.

## 4. Engine: reuse Bento's logic, no new library

1. **Keyboard.** None of the nine libraries measured has keyboard move or resize. gridstack 14.1.0 binds keydown only during a drag, for Esc. Bento already ships it.
2. **One source of truth.** gridstack would duplicate `pack()` and `resizeTo()` and drift from Bento's 400-step random-walk test ([CRM-STYLE-D5-BENTO-BOARD-2026-10-12](CRM-STYLE-D5-BENTO-BOARD-2026-10-12.md)).
3. **Weight.** Board logic plus host is about 5-8 KB gz, lazy (scaled from `bento.js` at 7.5 KB gz; an estimate). gridstack is 27 KB gz JS plus 6 KB CSS.
4. **Touch.** Pointer events with capture are the house pattern (`os.js:349`, `bento.js:620`).
5. **CSP.** Positions are set through classes or `style.setProperty('--gx')`, the CSSOM pattern of `os.js:137-141`. The **inline-style ratchet doesn't scan subfolders** (`readdirSync`, `inline-style-ratchet…test.js:57`), so files under `js/os/` and `js/layouts/` are invisible to it. We add a grep test that fails on any `style="` in new files, and that test is the only real guard: the Report-Only `style-src 'self'` (`firebase.json:148`) blocks nothing, and the enforced policy allows `'unsafe-inline'` (`firebase.json:147`).
6. **Ruled out:** Swapy (GPL-3.0), Muuri and dragula (stale), Shopify Draggable (archived), Pragmatic DnD (no resize, needs bundling).

**Fallback.** If the real-iPhone drag test fails, vendor SortableJS 1.15.7 (15 KB gz) lazily at `docs/assets/vendor/sortablejs/1.15.7/`, for phone reorder only.

**Sequencing.** P0 doesn't touch `bento.js`. In P1 the logic moves to `board-logic.js`, and a re-export test proves `require('bento.js').NBDBentoLogic` is unchanged.

## 5. Widget catalog v1

| Widget | Shows | Source, read cost | Sizes | Phase |
|---|---|---|---|---|
| At a Glance | date, next appointment *time* (no name), storm line, unfiled-visit count | `appointmentRows` stripped, `appointmentsFailed` (`today-home.js:999`), `stormLine` (`today-plan.js:767`), visits badge. 0 reads | S, M | P0 |
| Up Next | top 3 (M) or 6 (L) from the Today plan, each row deep-linking to the record | `last()` plus the `nbd:today-rendered` event (never `compute()`). 0 reads | M, L | P0 |
| Shortcuts | Record visit, New lead, Photos, Today | none | S | P0 |
| Daily Success | §5.1 | snapshot (0 reads), then `nbd_today_summary` | S, M, L | P0c personal, P1 business |
| Coach | §5.2 | rules over cached data. 0 reads | M, L | P0c |
| Needs you | counts per group, with tap-through | `lastCounts`. 0 reads | S, M | P1 |
| Closes this week | compact line or ranked list | `[data-cwk-compact]` (`closes-week.js:8-17`) | M, L | P1 |
| Storm | the cached alert | `nbd_storm_alerts_cache` (`today-home.js:165-166`) | S, M | P1 |
| Money | **collected** this month, in cents | `NBDRevenue` (already loaded) | S, M | P1 |
| Streak / Level | login streak, server XP | `getGameCard` (15-min cache, `game-card.js:23`); avatar only after `chibi-sheet.js` passes at S (rule g) | S | P1 |
| Leaderboard | team rollup | `leaderboard/{uid}` aggregate (N reads); today's widget sums float dollars (`widgets.js:597-599`) | M, L | P2 |

Every widget has four states: `loading` (skeleton), `failed` (age of the last good value plus Retry), `empty` (`.ui-empty` with one action, `DESIGN.md:229-230`) and `offline` (last value, "as of HH:MM"). Widgets refresh on events that already fire (`nbd:data-refreshed`, `online` and `offline`, `system.js:650`). One visibility-aware ticker drives the clock.

### 5.1 Daily Success

**Personal half (reading A).** Reads `nbd_ds_snapshot` (same device, 0 reads), else `dsSnapshot` from the doc already read at `layout-system.js:650`. Shown only when `today.dk` equals the *writer's* day key (`app.js:144`), `asOf` is under 12 h old and every count is whole; otherwise one line, "Open Daily Success", with no numbers. It shows floors X/N, the streak state (`warned` = "don't miss twice today", `broken` = "day one") and week %. It **never** shows weight, money or the scorecard, and never appears on the lock screen, tray or team views (the doc itself is readable only by the rep and the platform admin; the risk is shared screens, not company admins). Later: a `workout` block in `snapshotDoc` (`review-logic.js:159-170`), written by the DS page, the only page that loads `NBDCoach`.

**Business half (reading B, P1).** Plan counts at 0 reads already exist: `summaryForTracker` (`today-plan.js:757-763`: calls, follow-ups, jobs) is published as `nbd_today_summary` by `publishToTracker` (`today-home.js:291-297`), and Daily Success's "Today's business" tile reads it. Reuse it rather than building new counts; signed today (`numbers-logic.js:69,375`) is the only addition. Shown as "left", not "done", unless a completion stamp exists. Doors knocked reuses the existing `getCountFromServer` on `knocks`, loaded by dynamic import (`d2d-tracker-core-2026b.js:1899-1925`; the demo SDK already implements it, `docs/pro/demo-sdk/firebase-firestore.js`): 1 read per refresh, at most every 5 min, about 100 reads per rep per day at the outside, with a demo fixture (`demo-mode.js:15-18` blocks it otherwise).

**Goals.** The rep's own in `userSettings/{uid}.dsGoals`; the owner's in `companies/{cid}/settings/goals {byRole, byUid, locked}`, which the rules don't match today (only `settings/layout` exists, `firestore.rules:3310-3340`), so it needs a new rule block and an emulator test. Precedence lock > rep > company default > none. **No goal means progress with no target.** Each goal is labelled "set by owner" or "your goal". The invented 30 / 10 / 3 at `widgets.js:710` is a separate, out-of-OS-scope fix: it changes the Bento `floors` tile (`bento.js` catalog, `daily-floors`) and Classic Home, and `widgets-no-fabricated-data` doesn't cover `daily-floors` today, so that test needs a case first.

**Kind streaks.** Today `floorStreak` counts every calendar day, Sunday included, with no rest days or freezes (`review-logic.js:47-63`). Everything below is a **change to the tracker's own streak**: change the shared function and the Daily Success page together, or the widget and the tracker will disagree. Proposed rules: two misses in a row end a streak, one doesn't; workdays Mon–Sat, Sunday never counts against; at most 2 rest or rain days a week, tapped before the reset (Habitica's Inn), and away mode counts; freezes earned, 1 per 7 kept days, at most 2 held; **our outage repairs the day** (sync, call import or knock writes down; Duolingo's Big Red Button). No loss-aversion pushes, "you'll lose it" banners, public shaming or purchases.

### 5.2 Coach (rules first)

**Engine.** Pure `os/coach-logic.js`; each rule returns `{id, priority, text, evidence:{n…}, action}` and code inserts every number from `evidence`. Top rule shown, 2 more on expand; dismiss or snooze for the day; the same rule at most 3 days running.

**v1 rules (0 reads; only `_leads`, `NBDTodayPlan` and `lastCounts`)**
1. overdue promises, "missed N times"
2. estimates out 5 or 10+ days (`estimate-followups.js:196`)
3. missed calls not returned within 30 minutes (the `home-strips.js` rule; `home-strips` is a lazy bundle, `script-loader.js:571-588`, so either load it or re-implement the rule in `coach-logic.js`)
4. leads stuck in `new` 30+ days
5. `streak.warned`

**Deferred, labelled "loads D2D":** below-own-average knocks, the best knock window, and the workout split. They need the lazy `d2d` bundle (`script-loader.js:372`) or the DS page code.

**AI focus line (P2, opt-in per company).** A new callable `coachLine` with the prompt **built on the server**, not `claudeProxy`, which accepts a client `system` prompt (`ai.js:187,215`).
- **Input** is rule ids plus numbers only: no names, no free text. Haiku, `max_tokens` about 150, temperature 0.2, system rule "Use ONLY these facts; never state a number not listed."
- **Post-check:** every digit run must appear in the facts or be a code-supplied date, and **number words are forbidden** ("three", "dozen"). On failure the widget shows the rules text.
- **Bounds:** cache `coach_lines/{uid}_{ymd}` (client deny-all rule plus an emulator test), at most 3 fresh lines per user per day. The `claudeProxy` reservation is written inline (`ai.js:220-258,338`) and can't be reused; copy the `functions/lead-brief.js` pattern instead: `aiAllowed` (`:124-133`: paid plan, killswitch, verified email), `takeQuota` (`:136-141`: a per-uid daily doc) and `recordAiSpend` (`:104`). About 600 in + 120 out tokens, roughly $0.001 a line: about $0.03 per rep per month at 1 line a day, about $0.09 at the cap of 3 (an estimate; check current Haiku pricing). **Never runs on paint**; added to `pro-demo-callable-words-2026-10-24` and `pro-demo-zero-network`.
- **Fix first:** the D2D coach prompt has no fence, no no-invent rule, and runs at temperature 0.6 (`d2d-tracker-core-2026b.js:1190-1215`).

## 6. The "uncommon and powerful" lane

**Bar:** real minutes saved or revenue protected, on data the CRM already holds, inside the shell rule (the OS writes no CRM data of its own; every action calls an existing function, [NBD-OS-PLAN-2026-11-06](NBD-OS-PLAN-2026-11-06.md) :127-129). **Minutes are estimates**, assuming about 8 appointments or follow-ups and 40 app switches a day; P1 adds counters to check them.

| # | Idea | Desktop-OS inspiration | Real data (file:line) | Est. minutes per rep per day / revenue protected | Cost |
|---|---|---|---|---|---|
| 1 | **Smart Stack that knows the rep's day** | iOS/macOS Smart Stack; Glance `group`; Plasma containment | Today sections (`today-plan.js:12-35`), `appointmentRows` (`today-home.js:999`), `stormLine` (`today-plan.js:767`), `lastCounts` | ~5 min (estimate): no hunting for "what's next" | M |
| 2 | **Shutdown ritual: close the loop on every lead touched today** | Sunsama shutdown; macOS "reopen windows on login"; GNOME session save | `lastTouchMs` (`no-next-step.js:107-109`; over-reports, see §6.2), `hasNextStep` (`:84-86`), `followUpDue` (`today-plan.js:148`), the follow-up writer with undo (`followup-deck.js:43,47`), unfiled visits (`visit-unfiled-today.js`) | ~8 min (estimate); **revenue protected:** no touched lead ends the day without a next step | M |
| 3 | **Activities: job-phase workspaces (laptop) and modes (phone)** | KDE Activities; macOS Focus filters | stage keys (`crm-stages.js:17+`), 4 desks (`os-wm-logic.js:37`), `setDnd` (`system.js:499`), notification groups (`system-logic.js:118-135`), `away-mode.js` | ~6 min (estimate) for owners; **privacy protected** in a living room | M-L |
| 4 | **KRunner-style action runner: verbs on results, plus Quick Keys** | KRunner; GNOME SearchProvider2; Tahoe Spotlight Quick Keys | `registerAction` (`command-palette.js:733`), prefixes (`command-palette-scopes.js:36-40`), usage `USAGE_KEY` (`:30`) | ~6 min (estimate): "12 Oak → Call" in 2 keys instead of 4 taps | M |
| 5 | **Urgency ring for a new inbound lead** | i3 urgency hints; Unity LauncherAPI urgent | `firstRespondedAt` (`speed-to-lead.js:67`, `layouts/inbox.js`; only stamped when the flag-gated, lazy `speedToLead` feature runs, `dark-features.js:15,40`), the 30-minute call-back rule (lazy `home-strips` bundle, `script-loader.js:571-588`), `visitBadge`/`recLabel` (`os.js:1030,1033`) | **Revenue protected:** speed to lead; ~2 min | S-M |
| 6 | **Pre-flight peek 30 minutes before the next appointment** | macOS Quick Look; ChromeOS "Up next" date tray | `appointmentRows`, the lead brief (4-hour cache, `functions/lead-brief.js:11`, `functions/lead-brief-logic.js:23`; a paid callable capped at 60 fresh briefs a day, `functions/lead-brief.js:31`, so it opens on tap only, never automatically at T-30, with a canned demo answer), lazy `nextstop` (`script-loader.js:534-600`) | ~4 min (estimate); fewer cold walk-ups | S-M |
| 7 | **Welcome Recap: the first unlock of the day restores yesterday's shutdown carry-over** | ChromeOS Welcome Recap; macOS Resume | the silent restore (`os.js:546`), shutdown output (#2), Today plan | ~3 min (estimate) | M |
| 8 | **"Safe to drive off?" background activity** | GNOME 44 Background Apps; Android 16 progress notifications | `trayItems` counts (`system-logic.js:37`), `idb-cache.js` queue | **Data protected:** no lost photos or notes; ~1 min | S-M |
| 9 | **Pocket: a drop-down quick-capture over any app** | i3 scratchpad; Hyprland special workspace | `quick-capture.js` (W130 voice scratchpad), the window manager | ~3 min (estimate) | M |
| 10 | **Knock-block focus session** | ChromeOS Focus mode | knocks `getCountFromServer` (`d2d-tracker-core-2026b.js:1899-1925`), `setDnd` (`system.js:499`), DS floors | ~3 min (estimate); more doors per block | M |
| 11 | **Privacy hot corner, and double-tap-to-lock on phone** | macOS hot corners; Plasma Mobile 6.5 double-tap | `lock()` (`system.js:170`); the lock screen is counts-only (`system-logic.js:231-245`) | **Privacy protected** when a homeowner leans in; ~0.5 min | S |
| 12 | **Wallpaper → palette, pywal-style, inside the brand lock** | pywal; matugen / Material You | `accentFromSample` (`my-skin-logic.js:428`), `accentCheck` (`:562-571`), dim guard (`:533-557`) | 0 min, honestly; legibility over photos | M |
| 13 | **Frecency for Start and phone page 1** | rofi/fuzzel `drun` history | `USAGE_KEY` (`command-palette-scopes.js:30`), `pushRecent` (`os-wm-logic.js:302`) | ~1 min (estimate) | S |

### 6.1 Smart Stack

Pure `os/stack-logic.js`: input `{now, plan, nextAppt, storm, counts, dsSnapshot, dismissed}`, output `{childId, reason}`, with the reason shown under "Why this?". Rules in order: an appointment within 60 min shows the pre-flight peek (#6); a storm cached within 60 min shows Storm; a new inbound lead unanswered after 5 min shows Call back (#5); 05:00–10:00 Daily Success; work hours Up Next; 16:00–20:00 Shutdown (#2). It re-picks only on show, unlock and events, never on a timer. A table-driven test runs a simulated day.

### 6.2 Shutdown ritual

From 16:00–20:00 (or on tap) it lists every lead of the rep's own that was touched today and fails `hasNextStep`. `lastTouchMs` alone over-reports: it takes the max of `updatedAt`, `stageStartedAt` and three other stamps (`no-next-step.js:107-109`), so any server stamp counts as a touch; it needs a narrower touch signal, and a manager's `_leads` can include team leads, so filter to the rep's own. It also lists plus today's unfiled visits and overdue promises. Each row is one tap on an existing path: Tomorrow / +3 days / +1 week through the follow-up deck's `followUp` writer (which already has undo), Attach visit, or Open. It ends with "Loop closed: N leads, N visits" (numbers from code) and a carry-over list for the Welcome Recap, and it never nags (the DS end-of-day rule). It is the first OS surface to trigger a CRM write, so it waits for Jo's OK (Q2).

### 6.3 Activities

Named modes, each `{widget set, dock, focus filter, wallpaper id}`, at most 4, stored in `os-home` and counted in the max-fill test.
- **Phone:** Canvassing, In a home, Office, Storm day. "In a home" hides pipeline $ and other customers' names, and only time-sensitive toasts break through.
- **Laptop:** job-phase workspaces on desks 1–4 (Leads, Inspect/Claim, Build, Collect). Each filters Up Next and Needs you to leads whose stage role is in that phase and reopens its own windows.
- **Switching** is manual (tray, Spotlight). A storm may *offer* a one-tap switch but never changes the screen itself (Storm Mode rule, ROADMAP :138-139).

### 6.4 Action runner

`NBDCommand.registerProvider({id, prefix?, match(q) → [{label, actions}]})`: "12 Oak" returns the lead with Call, Navigate and Open on the row. Quick Keys are user aliases (`nl`, `rv`, `ds`). Type-anywhere on the desk opens it pre-filled (GNOME Activities), but only with focus on the desk itself and with a setting to turn it off, or it fails WCAG 2.1.4 (character-key shortcuts); an opt-in laptop hot corner opens it after a 250 ms dwell; the phone gets chips for `@ # > = t:`. Every field is escaped.

### 6.5 Rejected as gimmicks

Dock magnification; animated canvas wallpapers (battery, unreadable in sun); Stage Manager (L cost, owner-only); CPU/RAM monitors and visualisers; third-party wallpaper feeds (CSP); an AI that rearranges the home; gesture-only actions with no button or key path; tenant-supplied widget code; "send to my phone".

## 7. Boot weight and performance

**Budget:** shipped local 2,563 of 2,570 KB, so **the dashboard is 7 KB under its ceiling**; blocking 85 of 85 KB; local tags 200 of 200 (`tests/dashboard-boot-budget-2026-10-03.test.js:258-259`). **Any new `<script>` tag fails.** Everything new is lazy.

**Placement:** P0 takes `needs` paths 3–5 (`os/home-logic.js`, `os/home.js`, `os/coach-logic.js`) plus `needs.css` (`css/os/home.css`); P1 takes the 6th (`layouts/board-logic.js`), and **then `needs` is full**. Stack, shutdown, activities, runner and DS-logic code go in runtime ScriptLoader bundles loaded on first mount (the `my-skin-boot.js:16-17` pattern). Boot grows only about 0.3 KB, in `layout-system.js`, to share the userSettings doc it already reads (`:650`), so widgets add no `getDoc`. Today `readDoc` returns only `d.layout` (`:650-651`) and the prefs cache holds only layout; if `dsSnapshot` is surfaced, hand on only floors, streak and week, and never put scorecard, weight or money in the prefs cache.

**Runtime:** one visibility-aware ticker; no painting while a phone app is open (`S.phoneOpen`, `os.js:809-831`) or the tab is hidden; never the view-dash widgets' 5-minute timers (`almost-there-widget.js:352-364`).

**Headroom:** P0 edits boot-loaded files (`layout-system.js`, `today-home.js`, `widgets.js`), so shipped KB will rise. The gate is ≤2,570 KB, and about 1.2 KB is already reserved for held drafts #2994 and #3008 (`dashboard-boot-budget…test.js:258`), so real headroom is about 5.8 KB. Each PR records its shipped KB against that.

**Every phase checks:** boot test green (≤2,570 KB, 200 tags), the no-`style=` grep test green, a demo walk with `window.__NBD_DEMO__.blocked` empty, and no new `/cspReport` `style-src-attr` reports.

## 8. Phases

### P0: smallest safe slice, in three PRs

**P0a: the phone-wipe one-liner (its own PR).**
1. Copy the desk restore (`os.js:546`, `S.desk = st.desk; S.pins = st.pins;`) into the phone mount (`os.js:985`). Today the phone mount sets only icons, dock and recent, so `S` keeps its initial `desk:0, pins:[]` (`os.js:1108-1111`) and `normalizeState` writes them back. → check: failing case first in `nbd-os-layout` (a phone mount then save keeps `desk:3, pins:[…]`); the desktop restore path at `os.js:546` is unchanged.

**P0b: `os-home` key plus read-only widgets.**
2. **`saveUser` patch-only:** send only the changed `layoutState` keys, not the whole cached map (`layout-system.js:694,717`). → check: a failing cross-device test first (tab A saves OS windows after tab B saved `os-home`; B's `os-home` survives).
3. **`os-home` key:** `home-logic.js` normalises ≤12 `{id,s}` per surface, enum cfg ≤64 B, no stacks. → check: max-fill ≤12,000 and a round-trip test.
4. **Render without wiping:** the §3.3 choice (default: inside page 1 with a keyed reconcile in `phonePaint`); desk column as an ordered list. → check: boot test ≤2,570 KB / 200 tags with the shipped KB recorded (§7 headroom); grep test forbids `style="` in new files.
5. **Catalog, read-only:** At a Glance, Up Next, Shortcuts. → check: new `tests/nbd-os-home-<date>.test.js` proves every declared read cost is 0 and Up Next never calls `compute()`.

**P0c: Coach, Daily Success, editing.**
6. **Coach (5 rules) and the DS personal half.** → check: every Coach number comes from evidence; the DS half shows nothing but floors, streak state and week %.
7. **Edit mode:** tap-pick-place, S/M/L chip, Bento keys, Remove, the `<dialog>` add sheet, both reduced-motion switches. → check: 44px targets at 360px; the phone-fit e2e.
8. **Wallpaper tile:** `NBDMySkinBoot.load()`, then My Skin. → check: demo walk with no blocked requests.

**Out of OS scope:** the `widgets.js:710` fix (invented 30 / 10 / 3) changes the Bento `floors` tile and Classic Home; it gets its own PR with a new `daily-floors` case in `widgets-no-fabricated-data` first.

**Files:** `layouts/os.js` (P0a, P0b), `layouts/os-wm-logic.js`, `layout-system.js` (`saveUser`, `needs`, prefs accessor), `today-home.js` (only if `NBDToday.last()` needs a read-only accessor); new `os/home-logic.js`, `os/home.js`, `os/coach-logic.js`, `css/os/home.css`. No `bento.js`, `widgets.js`, rules or `<script>` change. **Tests:** all `nbd-os-*`, `layout-system-2026-10-11`, boot budget, `smoke`.

**What Jo sees:** the phone opens to a real Today block above the icons (next appointment, top 3, floors, one coach line), and the laptop column shows the same. Widgets can be added, resized, reordered and removed by tap or keyboard. Wallpaper is one tap away.

### P1

- **Board and drag:** `board-logic.js` lifted behind a re-export test; the 2D desk board (collapse, not hide, below 1100px); phone hold-and-drag, then a real-iPhone pass (SortableJS lazily only if drag fails).
- **Daily Success:** an OS app (`kind:'app'`, same tab, alongside Roof Rep, Social Studio and Maps); the business half from `nbd_today_summary` and goals (`settings/goals` with a new rules block and an emulator test); the doors count (existing `getCountFromServer`, demo SDK); the kind-streak change, made in `floorStreak` and the Daily Success page together.
- **Widgets:** Needs you, Closes week, Storm, Money (cents), Streak (after the chibi sheet).
- **Company home:** `os-phone`/`os-desk` arrays plus `homeLocked`, rules and `cleanDefaultWidgets`.
- **Uncommon lane:** Smart Stack (#1, `stack-logic` tests), Shutdown v1 (#2, behind Jo's OK), urgency ring (#5; needs `speedToLead` on for the stamp, and text or aria as well as colour), frecency (#13); time-of-day wallpapers and per-surface wallpaper ids.
- **Jo sees:** a top card that follows his day, an evening Shutdown that leaves no touched lead without a next step, an owner-published starter home, Daily Success in the dock.

### P2

- **Uncommon lane:** Activities and Focus modes (#3, "In a home" privacy), the action runner with providers and Quick Keys (#4), pre-flight peek (#6), Welcome Recap (#7), background activity (#8).
- **Coach AI line:** `functions/coach-line.js` + `-logic.js`, digit and number-word post-check tests, FUNCTIONS_INDEX entry, demo callable list.
- **Team:** the `leaderboard/{uid}` scheduled aggregate and an owner widget; `companyProfile.timeZone`.
- **Jo sees:** one tap to "In a home", "12 Oak → Call" from the keyboard, one honest focus sentence a day, a team board at N reads instead of the unbounded fan-out (`pages/leaderboard.js:93-109`).

### P3

Pocket scratchpad (#9), knock-block focus session (#10), privacy hot corner and double-tap-to-lock (#11), pywal surfaces (#12: tinted `--s`/`--s2` for tenants only under the 4.5:1 guard, NBD byte-identical, never customer documents), saved-filter KPI tiles (XFCE genmon), "Copy my setup" export/import, Nearby. **Jo sees:** the desktop-OS power features, each with a keyboard path.

## 9. Risks and what we will not build

**Risks**
1. **State overflow:** separate `os-home` key, hard caps, max-fill test.
2. **Legacy renderers** (inline styles, `#widgetGrid` delegation, own reads): per-renderer allow-list with read cost.
3. **Personal data on shared screens:** counts and floors only, never lock screen, tray or team views. `dsSnapshot` is readable by the rep and the platform admin only (`firestore.rules:20,27`), not by company owners or company_admins; keep it out of the prefs cache beyond floors, streak and week.
4. **Shell writes:** Shutdown only calls existing writers that have undo, after Jo's OK.
5. **iOS** long-press, nested scroll, safe area and callouts are unverified (`NBD-OS-PLAN:75-80`); a real-iPhone pass gates P1 drag.
6. **Characters:** any avatar widget passes `node scripts/chibi-sheet.js` at every size.
7. **`needs` is full after P1:** later code goes in ScriptLoader bundles.
8. **Time zones:** Eastern is hard-coded and the DS writer is device-local; compare with the writer's key until `companyProfile.timeZone`.
9. **Cross-device clobber of `os-home`:** `saveUser` re-sends the whole `layoutState` map (§3.5); fixed in P0b with a failing test first.
10. **Pre-flight peek (#6) cost:** `leadBrief` is a paid callable capped at 60 fresh briefs a day (`functions/lead-brief.js:31`); open on tap only, never automatically at T-30, with a canned demo answer.
11. **Accessibility:** type-anywhere on the desk fails WCAG 2.1.4 unless it can be turned off or fires only with focus on the desk; the urgency ring needs text or aria, not colour alone.
12. **Palette:** time-of-day gradients use `color-mix` from theme tokens only (`DESIGN.md:225-226`); no new hues.
13. **New Firestore paths:** `coach_lines` needs a client deny-all rule and an emulator test; `companies/{cid}/settings/goals` has no rules match today (only `settings/layout`, `firestore.rules:3310-3340`).
14. **Signals that depend on lazy or flagged code:** `firstRespondedAt` exists only when `speedToLead` is on (`dark-features.js:15,40`), and the 30-minute call-back rule lives in the lazy `home-strips` bundle (`script-loader.js:571-588`); load it or re-implement the rule.
15. **Shutdown over-reporting:** `lastTouchMs` counts any server stamp as a touch, and a manager's `_leads` includes team leads (§6.2).

**Will not build:** a grid library; iframes (Daily Success is `DENY` anyway); free x/y on phone; per-card `backdrop-filter`; paid streak repair or loss-aversion nudges; AI-written numbers; AI on paint; a new Storage path; a cross-user Daily Success view; the NBD-only morning brief or lead digest on the home (`morning-brief.js:5-6`, `lead-digest.js:19`); the gimmicks in §6.5.

## 10. Questions for Jo

1. **What do "Daily Success" and "Coach" mean on the home screen?** (A) your tracker and Workout Coach; (B) new sales widgets; or both? *Recommended default:* both, as two halves that can each be hidden. Reps see only the business half.
2. **Can the Shutdown ritual set follow-ups?** It would be the first CRM write the OS triggers, only through the follow-up deck's existing writer and its undo. *Default:* yes, with every row a single deliberate tap and nothing automatic.
3. **Can owners publish a team home and goals, and lock them?** *Default:* publishing yes; locking is off unless switched on per company.
4. **Do business floors count per workday or per week, and which days are workdays?** *Default:* per workday, Mon–Sat, with Sunday never counting against anyone.
5. **Activities: may a storm or away mode switch modes automatically?** *Default:* no. They offer a one-tap switch and never change the screen unasked, as Storm Mode already works.
6. **Is the AI focus line wanted?** About $0.03 per rep per month at 1 line a day, about $0.09 at the cap of 3 (an estimate). *Default:* yes, in P2, opt-in per company, after rules-only Coach has run for a few weeks.
7. **Phone home: widgets inside page 1, a block above all pages, or a separate Today page to its left (iOS-style)?** A block outside `.os-p-pages` shows on every page and shrinks the pager (§3.3). *Default:* inside page 1, with a keyed reconcile in `phonePaint`, which matches "one daily page as the home screen".

## 11. Verification

Checked against the code at HEAD c178a7818 (read-only); about 45 file:line claims spot-checked, and these were corrected:

- **Cites fixed:** the knock count is the dynamic-import `getCountFromServer` at `d2d-tracker-core-2026b.js:1899-1925` (not the `:1737-1739` comment), in §5.1 and §6 #10; the lead brief lives only in `functions/` and its 4-hour cache is `functions/lead-brief.js:11` / `functions/lead-brief-logic.js:23`; Bento has 18 catalog tiles (`bento.js:46-64`), 24 is `MAX_TILES` (`:43`); `phonePaint` is `os.js:761-791`, writes at `:787`, with 9 callers; the `homeLocked` precedence is new code following the `layout-system.js:192-221` pattern.
- **Claims restated:** `dsSnapshot` is readable by the platform admin only (`firestore.rules:20,27`), not company admins; the Report-Only `style-src` blocks nothing (the enforced policy allows `'unsafe-inline'`, `firebase.json:147`), so the new grep test is the only guard; `floorStreak` counts every calendar day (`review-logic.js:47-63`), so kind streaks are a change to the tracker's own streak; `lastTouchMs` over-reports (`no-next-step.js:107-109`); `firstRespondedAt` and the call-back rule depend on flagged or lazy code.
- **Reuse instead of new code:** the business half reuses `summaryForTracker` / `nbd_today_summary` (`today-plan.js:757-763`, `today-home.js:291-297`); Up Next reads `last()` plus `nbd:today-rendered` (`widgets.js:1500`) instead of calling `compute()`, which mutates handled-call state (`today-home.js:43`); `coachLine` copies the `functions/lead-brief.js` gate (`aiAllowed`, `takeQuota`, `recordAiSpend`), not the inline `claudeProxy` reservation.
- **Persistence:** a separate `os-home` key is not isolated, because `saveUser` re-sends the whole `layoutState` map (`layout-system.js:694,717`); P0b fixes it patch-only with a failing test first. The phone-wipe fix is the smaller one-liner copying `os.js:546` into the phone mount at `os.js:985` (confirmed: the phone mount never sets `desk`/`pins`, `os.js:1108-1111`).
- **Phone layout:** the §3.3 / Q7 contradiction is resolved into an explicit choice (inside page 1 with a keyed reconcile, or above all pages, `os.css:194-196`).
- **Numbers:** the AI line is about $0.09 per rep per month at the 3-a-day cap; boot headroom is about 5.8 KB after the ~1.2 KB reserved for #2994 and #3008 (`dashboard-boot-budget…test.js:258`), and P0 will raise shipped KB.
- **Plan:** P0 split into P0a / P0b / P0c; the `widgets.js:710` fix moved out of OS scope with a `daily-floors` test case first; the prefs cache carries only floors, streak and week.
- **Risks added:** cross-device `os-home` clobber, the paid pre-flight peek, WCAG 2.1.4 and colour-only urgency, token-only gradients, and rules for `coach_lines` and `settings/goals`.
