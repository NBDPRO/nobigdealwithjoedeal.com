# Grabber: what shipped and what is left (status, 2026-10-22)

Grabber is a Grok Bot roster agent. In its 2026-10-10/11 conversation it produced
eight CRM layouts, 12 design ideas, Pixel World, a private per-theme wallpaper pack
(one image per theme, about 113 MB, **never in the repo**) and a spec,
"Per-theme backgrounds for My Skin". Three build sessions started 2026-10-19
(wallpapers, remaining design ideas, layout visual audit). This note checks `origin/main`
and the PR list, not the sessions' own claims. Earlier matrices:
[GRABBER-12-IDEAS-RECON-2026-10-19](GRABBER-12-IDEAS-RECON-2026-10-19.md),
[MY-SKIN-WALLPAPER-RECON-2026-10-19](MY-SKIN-WALLPAPER-RECON-2026-10-19.md),
[VISUAL-AUDIT-LAYOUTS-2026-10-19](../audit/VISUAL-AUDIT-LAYOUTS-2026-10-19.md).

## Shipped (merged PRs)

| Area | PRs |
| --- | --- |
| Wallpaper spec phases 1-4 (per-theme picture, bulk zip import, grid, slideshows, company sets suggested or enforced, ambient accent, 1 GB/person and 500 MB/company caps) | #2334, #2340, #2342, #2347, #2348, #2343 (10-12) |
| The one missing piece: "Background style: Color theme / Real theme wallpaper" radios | #2540, then #2557 (restore on/off, name company background), #2560 (behaviour tests) |
| Phase 5 new themes (twelve) and Theme Morph | #2326, #2324 |
| 12 design ideas: 11 of 12 in the 10-11/12 roadmap run; #12 Sunlight in every layout (Off/On/Auto at a customer, default off) | #2551, hardened #2558, #2561 |
| Idea #11 roofing-weather chip on the Mission route | #2554, behind flag `roofWeatherChip` (absent = off) |
| Idea #02 glass guard | Not a gap: `nbdSurfaceMinFrost` already clears 4.5:1 over black and white |
| Layouts (Bento, Island, Inbox, Focus, Field, Mission, Crew, Classic) | on main since 10-13 |
| Layout visual audit: nine defects fixed plus wallpaper-text readability | #2541-#2548, #2549, #2553 |

## Unmerged branches and worktrees

Squash merges make `git rev-list` "ahead" counts for old `feat/myskin-*`,
`feat/layout-*`, `feat/pixel-*` branches meaningless: their PRs are merged (list above).
Nothing Grabber-related is an open PR today. Open PRs are tracker, call-center, calendar,
a11y and docs work, none of it Grabber. The only live unmerged Grabber-adjacent leftovers:

- `feat/ds-layout-switch` (tracker layout-switch plumbing, one commit, 10-22). Tracker
  work, not Grabber; belongs to the tracker lane.
- No worktree exists for the three 10-19 sessions; they finished and merged.

## What is actually left (smallest first)

1. **Jo imports the pack and looks on a phone.** The importer, the grid and the
   style radios are live, but wallpaper is opt-in and the pack lives only on Jo's
   account. Nothing here has been exercised on a real device. Steps: Settings,
   Appearance, My Skin, Background style "Real theme wallpaper", Import a pack.
   Expect all themes matched and previews ignored.
2. **Smallest code next step:** a per-control scrim for quiet buttons sitting straight on
   a picture (about 2.3:1 on a busy wallpaper; Island "Customize", Home quick actions).
   Do it once, with whoever owns `my-skin*.js` and `my-skin.css`. The audit's own Open row 5.
3. Optional polish: theme-preview tabs for Pipeline and Phone (#04), route-aware
   "almost there" nudge (#09), one-line accent-text rule (see decisions).
4. Not buildable yet: the Crews chip on Mission (no truck-location source).

## Decisions for Jo

1. Accent text: flip `--accent-fg` to dark ink when white is under 4.5:1 (today under
   3:1). One line, fixes 205 of 209 failing combinations, default theme unchanged.
2. Flip flag `roofWeatherChip` in the Firebase console (Claude cannot write prod flags),
   after a look at the chip.
3. Live crew locations for idea #11: want a data source, or leave the chip a stub?
4. Daylight and installed-iPhone pass on Sunlight, Storm banner, rich cards, wallpaper in
   light mode, and layout safe-area insets (automation cannot set them).
5. Do the remaining Open rows of the layout audit (pipeline chip palette, header accent on
   dark bar, brand orange as text on the customer page) get scheduled?
