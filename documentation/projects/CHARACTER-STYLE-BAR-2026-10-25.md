# The character style bar (Jo, 2026-10-25)

**Standing rule (CLAUDE.md, rule g).** Jo set the bar for every character, sprite and animation in
the product on 2026-10-25, in two sentences:

> "I want to build with this level of detail and style or above."
>
> "They need to look super clean and no overlapping of items, accessories, outfit etc."

"This level" is the two reference images Jo sent, kept in the vault:

- [ref1-robe-pixel-vs-vector.png](../brand/character-style/ref1-robe-pixel-vs-vector.png): one hooded
  robe drawn twice, as pixel art (left) and as a clean vector rendering (right). The right half is the
  target: dark outlines of one weight, three to four tones per cloth as hard-edged shapes, fold strokes
  in the shadow tone, a rope belt with real twists and tassels, a torn hem, boots with highlights.
- [ref2-hooded-lantern-8-angles.png](../brand/character-style/ref2-hooded-lantern-8-angles.png): a hooded
  figure with a dark face cavity and glowing eyes, a satchel across the chest, a glowing lantern that
  lights the nearby cloth, painterly folds and rim light, drawn from eight angles (front, three-quarter,
  side, back and their mirrors).

## What the bar means for the renderer

Every avatar is one procedural vector chibi (`docs/pro/js/chibi.js`, guard
`tests/chibi-2026-10-25.test.js`), and it stays procedural: Canvas 2D only, no image assets, every look
combination (9 hairs × 4 hats × 4 beards × tops × tools × props × 4 builds × 16 poses) and every size
(22 px on the street, 64 px on the game card, 36–44 px busts, 150 px in the locker) keep working. The
bar applies to that renderer:

1. **Detail at or above the references.** Cel-shaded garments (base, shadow, light tones with fold
   strokes and a rim light), consistent outlines, layered accessories drawn as real objects (a belt with
   twists, a satchel, a lantern with a glow), hems and seams, a face that reads in a hood's shadow.
2. **Super clean.** No part drawn through or over another where it should not be: hair through hats,
   tools through legs, arms through faces, props through torsos, eyewear off the ears, beards over
   collars; no part clipped by a crop, detached from the body, or out of z-order; features that stay
   legible at every shipped size (details drop below a size threshold rather than turning into mud).
3. **Judged by rendering, not by reading.** A character change renders the combinations it touches in
   Chromium and the sheet is looked at before it ships. `node scripts/chibi-sheet.js <spec.json> <out.png>`
   renders a grid from a JSON spec through the shipped renderer (the spec shape is in the script's
   header); the guard pins the geometry afterwards.

## Every surface the bar covers (Jo, again, 15:25 UTC: "for all characters, sprites etc")

The inventory of everything in the product that draws a character or a sprite, so none is left at the old
level:

| Surface | Drawn by | Where it shows |
|---|---|---|
| The vector chibi (every avatar) | `docs/pro/js/chibi.js` | Roof Rep: the street rep, homeowners at the door and leaving, the rival, Big Dave, the crews in the build, nailing and ladder mini-games, the course-card demos, the speech-sheet busts, the HUD face, the locker preview, the level-up card, the Crew board rows. CRM: the Home game card (through `game-sprite.js`), `/pro/leaderboard`, the dashboard Leaderboard view and the Team Leaderboard widget (`dashboard-api.js`, `widgets.js`, `pages/leaderboard.js`) |
| The 32×32 pixel avatar | `docs/pro/js/game-sprite.js` | The game card's fallback when `chibi.js` is not on the page, and both pickers' option tables; still shipped, so it is held to the bar or retired |
| The Roof Rep scene sprites | `docs/pro/js/pages/roof-rep.js` | the yard dogs and the sheet's barking dog (`drawDog`), the cars and the pickup (`drawCar`, `drawTruck`), the houses and their doors (`drawHouse`), the build scene (`drawBuild`), the ladder card (`drawLadder`), the roof-anatomy diagram (`drawAnatomy`), and the old pixel painter fallback (`paint`) |
| Pixel World | `docs/pro/js/pixel-world.js` (+ `pixel-world-logic.js`) | the player, the townspeople (the user's open leads), the six buildings and the town tiles, drawn from string patterns |
| Pixel Mode | `docs/pro/js/pixel-mode-core.js` | the Crew and Rep Card figures and badges |
| Weather and effects on the street | `docs/pro/js/pages/roof-rep-fx.js` | rain, snow, leaves, the evening tint, bursts (these frame the characters and are judged with them) |

Not characters (not under this bar): the theme art tiles (`scripts/build-theme-art.mjs`), the photo, e-sign and
signature canvases, the 3D roof viewer.

## Decisions (Jo)

- **2026-10-25 23:40 UTC:** the HD cast (Grabber's original pixel art) replaces the old procedural characters. The
  questions this note carried (proportions, views, outfits) are closed as moot: the painted restyle in
  [the plan](CHARACTER-STYLE-PLAN-2026-10-25.md) is cancelled, and the old chibi gets overlap and clipping fixes only
  until layered HD avatar sheets (hair, cap, shirt) exist and a cast loader can draw the saved looks. **The bar itself
  stands for the HD cast:** every sprite wired in is rendered and looked at before it ships (rule g), and art changes
  go through Jo to Grabber, who owns the art.

## Status

- 2026-10-25: the clean-up audit ran as a workflow (twelve finders by dimension, a sceptic per body part over the
  127 findings, one fixer per part, a critic over the full 576-look matrix); its fixes land on the renderer with guard
  pins. The prototype panel ran the same evening (six attempts; the art and product judges ranked crisp-chibi >
  crisp-tall > cel-chibi > paint-tall > cel-tall > paint-chibi and kept the chibi proportions with the head at about
  38–40 %). A third workflow drew the street dog to the bar (three cel-shaded attempts, two judges, the winner
  `animation-first` integrated into `roof-rep.js`). All three stalled on the account's session limit after their
  first phases and were resumed from cache at 22:03 UTC. Outcomes: the dog landed (one commit, `roof-rep.js` v14,
  gates green, renders looked at); the panel's synthesis is
  [CHARACTER-STYLE-PLAN-2026-10-25](CHARACTER-STYLE-PLAN-2026-10-25.md) with the contact sheet in
  `brand/character-style/`. Both notes that log them: the
  [10-25 handoff](NEXT_SESSION-2026-10-25.md) and the [Roof Rep game note](ROOF-REP-GAME-2026-10-03.md).
- 2026-10-25, the sprite packs Jo uploaded (Mana Seed base demo, Mana Seed Farmer sample, Craftpix tiny heroes) were
  measured against this bar and the renderer: the recommendation is to keep the procedural renderer and redraw it
  pixel-crisp at Mana Seed proportions (route R3 in the handoff), and to use the Mana Seed demo as-is in Pixel World,
  the one surface where a 29-px four-direction walk is the whole need. The Pixel World lane runs as a fourth workflow
  (`pw-local`); the Mana Seed sheets are held to the same bar (hair under hat, outfit under hair, nothing through the
  HP bar or the "!" bubble, feet on the tile) and judged by rendering before they ship.
- 2026-10-25 23:40 UTC: Jo chose the HD cast. The Mana Seed Pixel World lane was stopped (its worktree `pw-local`
  stays unmerged) and Grabber's games handoff took its place (see the 10-25 handoff).
