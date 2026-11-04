# Games handoff paused until Grabber is done (2026-10-26)

**Decision (Jo, 2026-10-26 about 00:10 UTC):** hold the Pixel World and Roof Rep work until Grabber, the visuals agent,
is done, and Jo will say when ("You tell me"). The reason is in the numbers below: Grabber published v8b at 22:33 UTC,
v9 at 22:48 and v10 at 23:15 on 2026-10-25, then said a full production-grade pass was starting. Anything wired in now
would be redone within hours.

## Update 2026-10-26 03:10 UTC (what changed after the pause began)

The CRM games stay paused; the facts below supersede the "Where Grabber's work lives" section, which is the 00:03 UTC state kept as history.

- **Merged since:** #2741 (the evening-clock test fixes: two unit suites and four e2e specs), #2742 (the street dog and the
  vault notes), #2743 (Lead Book, Crew and Rep Card), #2744 (the About page's orange American Operator banner). #2740 (the dark
  footer banner on 287 pages) stays a draft: it needs new landing, login, register and pricing visual baselines that the
  sandbox cannot fetch.
- **Grabber's current files** (INDEX.md in the Drive folder is the entry point; every zip is now under 5 MB with stable part
  names): Pixel World **v11** (126 PASS) and Roof Rep **v6** (22 PASS, still a mockup); v10 and Roof Rep v5 are superseded.
  The GDD Doc and its .md copy were renamed in place to "Life of a Roofer" (same ids). No atlas manifests or scene anchors
  for the CRM games yet, no wallpaper licence answer yet.
- **Life of a Roofer art drops 1 to 6** (painted HD from drop 3 on): all formats, field names and quirks are recorded in
  the new repo's `CONTRACTS.md` sections 11 and 11.1 (left-facing rows, `drawScale`, loop flags, `hammer-hit` active
  frames, the HUD and touch kit, the Tiled `collision` property).

## What is paused, what keeps going

| Paused until Jo says go | Keeps going |
|---|---|
| The prototype folder (`docs/pro/games-proto/`), the Pixel World port behind a flag, the Roof Rep file split, any HD-cast wiring | The Dex, Party and Trainer Card rename to Lead Book, Crew and Rep Card in the live Pixel Mode and Pixel World (Jo chose it; shipped as #2743 with the new-lead prompt reworded to NEW LEAD!) |
| | The clean-up audit's overlap and clipping fixes to the old chibi (it stays live until the HD cast is wired) |
| | The street dog, the vault notes, CI health |

## Jo's decisions of 2026-10-25 and 26 (all in multiple choice)

- The HD cast replaces the old characters; the painted restyle in [the plan](CHARACTER-STYLE-PLAN-2026-10-25.md) is
  cancelled; the old chibi gets overlap and clipping fixes only.
- One Pixel World in the CRM (the live town plus Grabber's map, quests and look), decided by the coding agent at
  Jo's request. The port starts only after Grabber's production pass.
- Reps pick finished preset characters first; hair, cap and shirt layers later, if still wanted.
- Job XP is visible to the rep and their managers. Real-lead practice in Roof Rep is out for now.
- Dex, Party and Trainer Card become Lead Book, Crew and Rep Card.
- One pushable branch per piece of work, each its own draft PR; the games prototype PR is never merged or
  auto-merged without Jo.
- Restart: Jo tells the coding agent.

## Where Grabber's work lives

Jo's Google Drive folder `NBD-Pro-Games-Handoff` (id `1RlAdYTWCKv_9Pn5mgCVizi7vnkI4GQsn`). Read `START-HERE.md`, then
`HANDOFF.md`, then `INDEX.md` (its Current table names the live files). State at 00:03 UTC on 2026-10-26:

- Pixel World v10, one 1.74 MB html file (selftest 96 PASS by Grabber's own run); Roof Rep v5, a 49 KB html with a real
  `assets/` folder (497 PNG, 5 JPG, 3 Barlow Condensed TTF; selftest 12 PASS), also as a 2.4 MB single file.
- Not available to the coding sandbox: `nbd-art-v10-rr5.zip` (25.6 MB, holds `src/pw10`, `src/roofrep-v5` and the hero
  atlas), `NBD-Pro-Games-Handoff-v10.zip` (34.9 MB), `nbd-sprites-v8b.zip` (4.8 MB, untested). The Drive connector drops
  its connection on a 6.8 MB download. Jo is asking Grabber for zips under 5 MB.
- Grabber's open issues for v10 and Roof Rep v5: the new homeowners walk by turnaround views plus a leg swing, not a
  hand-drawn four-frame walk; lighting is a grade, not real light; Roof Rep v5 is a visual mockup with no game loop,
  scoring or save; the atlases are still base64 inside the html; layered avatar sheets (hair, cap, shirt) do not exist;
  retiring `chibi.js` is not done.
- Stale in Grabber's notes: the "do not merge PRs #2586 and #2582" warning. Both merged on 2026-10-20.

## Requests sent to Grabber (through Jo)

Split sources into zips under 5 MB; a JSON manifest per atlas (frame rectangles, feet and centre anchors, frames per
direction, timings; rows append-only); 8 to 12 finished preset reps with idle, walk in four directions, talk, cheer,
sad, point, knock, wave and portraits; a JSON of anchors per Roof Rep scene (door, porch, roof points, map pins); upload
first, update `INDEX.md` last, a `CHANGELOG.md` line on top. Questions: who made the lightning wallpaper and under
what licence; Barlow Condensed under the SIL OFL with its licence file; will atlas file names stay stable.

## The restart recipe (the first round proved it on v8b; redo it on whatever is current)

Safe first step from `START-HERE.md`: copy only the current Pixel World file and the Roof Rep folder into
`docs/pro/games-proto/`, example data only, then a draft PR for Jo. They cannot be copied as they are:

1. **Inline scripts are blocked.** `firebase.json` sends `script-src 'self'` and `script-src-elem 'self'` (no inline,
   no eval) and `font-src 'self' https://fonts.gstatic.com` (no data: fonts). `check-inline-html-scripts` skips
   `docs/pro`, so CI would not notice a dead page. So each inline `<script>` body becomes an external file in the
   same position with `defer`, byte for byte, and each base64 TTF in the CSS becomes a real file. Inline `<style>`
   stays (the `/pro` CSP allows it). Add a `noindex` meta (robots.txt does not cover `/pro/games-proto`).
2. **The self-test used `new Function(...)`**, which throws `EvalError` under that CSP: the unmodified v8b script
   stopped at 49 PASS plus 1 error. The one use was replaced by static `typeof` checks (same scope, same answer) and
   the test proves that reverting that single substitution restores the original script body exactly. Find the
   same line in the current file.
3. **Prove it under the real headers**: the Firebase hosting emulator with the repo's `firebase.json`
   (`env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy npx firebase-tools emulators:exec --only hosting --project nobigdeal-pro ...`
   from `tests/`). Selftest counts at 390x844 DPR 3 and 1280x800, zero violations, same-origin GETs only, and an
   original-versus-converted pixel comparison with seeded `Math.random`, a fake clock and animations off.
4. **Gates that walk `docs/pro`**: `scripts/normalize-favicons.js` needs one commented SKIP line for
   `pro/games-proto/` (and `tests/favicon-contract.test.js` follows it); register the new guard in
   `tests/ci-manifest.json`; the deploy-time esbuild (`scripts/minify-shipped.js`, pinned 0.28.2) must minify the new
   scripts and the minified Pixel World must still pass its selftest.
5. **One commit, an upstream that cannot push to `main`**: run `git branch --unset-upstream` on a branch cut from
   `origin/main`, then `git push -u origin <local>:claude/games-proto-2026-10-25`.

## Findings from the first round's two reviewers (19; the five that matter)

- **Do not merge until Grabber answers:** the 1440x900 lightning wallpaper (a 90 KB JPEG) embedded in Pixel World has no
  stated source or licence, and it is visibly rendered. It would be published on the production domain.
- `ATTRIBUTIONS.md` line 17 names a CC0 pack "Zelda-like tilesets and sprites by ArMM1998" (the pack's own title). Keep the
  verbatim file; ask Grabber whether any ArMM1998 asset is actually used. If not, the line can go.
- The in-game CREDITS panel omits seven of the 15 `ATTRIBUTIONS.md` entries (the required m6x11 line is there; only
  Cainos is not CC0).
- README claims must be measured: no report ever reached `/cspReport` in the reviewer's runs; the hosting emulator
  serves `README.md` and `ATTRIBUTIONS.md`.
- The first round's pixel-parity numbers were not reproducible by the reviewer; the comparison must be repeatable.
- Art notes for Grabber (never fixed here): touch D-pad overlaps the lower map, label overlaps in Roof Rep (JO/CREW,
  HOA PRESIDENT over the door), no reduced-motion handling in the Roof Rep mockup, poor phone landscape, the bank
  panel hard-codes revenue figures outside the example-data block.

## New track: Life of a Roofer (started 2026-10-26, separate from the CRM games above)

Grabber's message to the coding agent (relayed by Jo) starts a **standalone story game**, "Life of a Roofer", for
`play.nobigdealwithjoedeal.com`. It is not part of the CRM and not part of this pause: it has its own repo, its own
Firebase project for saves and leaderboards, and no access to NBD Pro data. The master plan is the GDD v1.2 (Google Doc in
the Drive folder; its section 17.1 has the 14-step build order).

- **Built now, with placeholders only:** the canvas engine and project structure, movement, hammer swing, Hammer Drop and
  camera, local saves with JSON backup and restore, the cloud-save design on a separate Firebase project (rules and
  functions tested on the emulator), the leaderboard backend with opt-in names and basic anti-cheat, menus, difficulty
  and settings, and the hosting and DNS runbook (GDD 13.9). The coding agent writes the runbook only; Jo does the DNS,
  billing and Firebase-project steps.
- **Waiting on Grabber:** all final art and all audio. The coding agent draws boxes in code and never sources sound.
- **Jo's decisions (2026-10-26):** saved-game names use the real title (`life-of-a-roofer`, local database `nbd-lor`)
  instead of the doc's old working title; on-screen difficulty labels are the roofer names with the plain name under them
  (Apprentice / Easy, Journeyman / Normal, Master Roofer / Hard, Warranty Season / Challenge); the code lives in a free
  private GitHub repo that Jo creates (GitHub would not let the agent create it), with a Drive zip as the fallback.
- **Rules that carry over:** no CRM data, no Pokémon, Zelda or Nintendo content, nothing public without Jo, and the
  stale "DO NOT MERGE #2586 / #2582" warning in Grabber's notes no longer applies (both merged on 2026-10-20).

## Other decisions of 2026-10-26

- The Lead Book / Crew / Rep Card rename ships as its own PR. The new-lead prompt now says NEW LEAD! (Jo's pick); the
  Poké Center and Pokemon themes in the CRM theme catalog stay, because they are part of the pop-culture themes Jo asked for
  on 2026-10-01.
- American Operator banners are split: the About-page banner is its own PR; the footer swap on 287 pages waits for new
  landing, login, register and pricing visual baselines that the sandbox cannot fetch.

- DNS for nobigdealwithjoedeal.com is hosted on **Cloudflare** (Jo, 2026-10-26; also named "likely Cloudflare or GoDaddy" in `BIG_ROCKS.md`). `CLAUDE.md` says Cloudflare appears only as Turnstile and "is not the host": that is true of web hosting (Firebase) but not of DNS, so its Stack bullet should say so in the next docs PR. The Life of a Roofer hosting runbook is written for Cloudflare's dashboard (grey-cloud `play` records, no change to the main site's records).

## Not started on purpose

The Roof Rep file split should wait for Grabber's atlas manifests and scene anchors, so the module boundaries (a cast
loader, scene placement) fit what is delivered. The Pixel World port waits for the production pass.
