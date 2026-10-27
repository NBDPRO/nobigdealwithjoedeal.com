# Character style upgrade: the plan (synthesis lead, 2026-10-25)

> **Status (2026-10-25 23:40 UTC): cancelled by Jo's decision that Grabber's HD cast replaces the old
> characters.** The plan stays as the record of what the panel found; no wave below is scheduled. If the HD cast
> stalls and Jo reopens the painted route, wave 1 needs no decision and is the place to start.

**What this is.** The output of the painted-style prototype panel run on 2026-10-25 for the
[character style bar](CHARACTER-STYLE-BAR-2026-10-25.md): six independent Canvas 2D attempts (cel, painterly and
crisp-vector, each at chibi and 3.5-head proportions), three judges (art, product, engineering), one synthesis. The
contact sheet with both references and all six attempts in the judges' order is
[contact-sheet-2026-10-25.webp](../brand/character-style/contact-sheet-2026-10-25.webp) (1200 px; the 3600 px
original and every attempt's page live in the session scratchpad under `render/proto/`). Section 5 is the list of
decisions only Jo can make; nothing in waves 4-7 starts before them. Waves 1-3 need no decision and fit the
shipped-bytes ceiling.

Inputs: Jo's two references, six Canvas 2D prototypes (cel / painterly / crisp-vector, each at chibi and
3.5-head proportions), three independent judges, `docs/pro/js/chibi.js` (63.4 KB readable, 36.8 KB minified
with the deploy minifier, 103 guard pins in `tests/chibi-2026-10-25.test.js`).
Contact sheet: [contact-sheet-2026-10-25.webp](../brand/character-style/contact-sheet-2026-10-25.webp).

Combined ranking (three judges, 150 points): **crisp-chibi 124**, crisp-tall 119, cel-chibi 99 (rank sum 11),
cel-tall 99 (rank sum 12), paint-tall 96, paint-chibi 89. All three judges ranked crisp-chibi first and all
three said keep the chibi proportions; none split.

## 1. Recommended direction

**Technique: the crisp cel recipe (crisp-chibi as the base) with the best pieces of the other five grafted in.
Proportions: keep the chibi exactly as today (100×120 box, head (50,42) r 29).**

Why the crisp recipe, in the judges' words:

- It is the closest match to reference 1's clean-vector half: one uniform ink weight stroked *on top* of the
  fill, three to four flat tones per material as hard-edged shapes (a half-plane band, a crescent of two offset
  ellipses, slanted bands that follow a flare), fold strokes in the shadow tone, detail carried by shapes (rope
  twists, knot, tufted tassels, torn hem with fold shadows, laced boots, hardhat ribs, vest tapes). Zero
  gradients, so it is the cheapest of the six and the most deterministic to pin.
- It is the only language that survived the two shipped sizes: at 26 px the rep still shows hat + face + vest +
  hammer and the homeowner hood + cavity + lantern; at 64 px it is the cleanest cell on the panel. Every
  painterly attempt was muddy at 64 and a smear at 26, so painterly passes (texture, rim, AO) belong above
  110 px only, if at all.
- It drops into chibi.js part by part: same unit box, feet origin, `s = h / 120`, and `Pen.limb` keeps
  `Pen.jointed`'s exact signature and angle convention, so `poseOf` / `mixPose` / `tween`, all 16 poses, the
  builds, the gaze, the pop-in, the turn and reduced motion carry over untouched.

What to graft from the others (each judge named the same ideas):

| From | Take |
|---|---|
| crisp-tall | the costume vocabulary: cowl with radiating folds + a pale rim on the lit edge of the opening + an arched near-black cavity with two glowing eyes (no eye whites, no smile); a separate mantle part so the hood tilts and turns from the neck; rope with twist ticks, a two-loop knot, hanging ends with tufted tassels; hoodie hood-back + strings + hem rib; jeans fly and pocket arcs; boots with a toe cap and a welted sole; vest with shoulder and chest tape and a brighter centre line; the hammer's head drawn in the highlight tone at lod 0; the stepped flat lilac patches clipped inside the robe where the lantern lights it; the posed cells (wave + tilt + turn, hood looking aside with the lantern raised) as the standing QA row |
| cel-tall | the `needClip` gate (skip save/clip/restore when a part needs no inner band at this LOD: 5 clips at 26 px instead of 25); the light vector rotated into each limb's frame so the shade stays on the screen's lower-right in every pose; per-segment capsules drawn end-to-root so no elbow angle can self-intersect; the lozenge rope braid at lod 3; form-shadow wedges as optional per-part data; the `screen`-composited lantern radial inside each cloth part's clip at lod 3 only |
| cel-chibi | hard cast-shadow bands as one clipped fill each (brim across the forehead, head on the chest, belt on the robe); the mirrored facing that also flips the light's x so the key light stays upper-left; the deterministic torn-hem generator; a soft radial in the air under the flat lantern rings so the glow reads as light rather than a sticker |
| paint-tall / paint-chibi | the draw-order rule for a lit prop (the glow pass runs after the body group and before the head, where `p.dust` draws); the warning that additive `lighter` washes out on a light page (use source-over at lower alpha); the 24×24 speckle tile only ever at the locker LOD, and only if Jo wants grain |
| today's chibi.js | keep the rep's face: the big iris with a highlight, blush, mood mouths, brows, blink, wink, smirk. Two judges called crisp-chibi's white-disc eyes the one thing it lost. |

Why keep the chibi proportions (all three judges, the same four reasons):

1. **Legibility is the product constraint.** At 26 px a chibi head is ~11 px and carries hat, face, mood and
   gaze; a 3.5-head figure's head is ~7 px and in every tall attempt the street rep collapsed to a hard hat on a
   stick. The 64 px game card, where a rep sees their avatar most, is where the chibi cells were clearest.
2. **The rig is tuned to it.** `poseOf`'s reach numbers, `gazeAt`'s head constants, `paintCanvas`'s bust crop
   and `headRise`, the emote anchors, the four builds, both pickers' thumbnails, the street scale against the
   houses and 103 guard pins all assume head (50,42). Both tall attempts admit the head moves to (50,21-22):
   a re-authoring of most of chibi.js, not a port.
3. **The detail Jo wants lives in the rendering recipe, not the skeleton.** crisp-chibi already carries
   reference 1's folds, rope, tassels, hem and boots and reference 2's hood, cavity, satchel and lantern on the
   chibi body; crisp-tall's extra costume detail transfers with no change of anchors.
4. **Reference 2 is itself about three heads tall** (a big hood on a stocky body), nearer the chibi than to
   3.5 heads; reference 1 has no head at all.

Where a taller figure genuinely wins (a natural walk, a grown-up read for the foreman or a boss persona), reach
for it through the existing `BUILDS` mechanism (`tall` already stretches the body group 1.12× with a 0.93 head);
a future `elder`/`boss` build toward 2.8-3 heads keeps the head anchor and every pose. crisp-chibi's modest head
shrink (r 26 at (50,38)) is as far as it should ever go and is *not* recommended for the first pass: it shifts
the bust crop, `gazeAt` and every face pin for no legibility gain.

## 2. Waves (each one PR; every wave leaves all 576 looks × 16 poses × 4 builds, the cross-fades, the turn, reduced motion and every size working)

Conventions for every wave: ES5, classic script, no `Path2D` (the guard's vm box has none), no inline scripts,
ink always stroked last, one light vector `L = (-0.55, -0.835)` in screen space, `mat(base)` tones cached per look
(`b` base, `d` shade −13% L / +5% S / hue −7°, `dd` deep −27% L, `h` highlight +12% L / hue +6°), and the PR
attaches the rendered sheet (`node scripts/chibi-sheet.js tests/chibi-style-sheet.json <out.png>`) per rule g.

**LOD ladder (final, by `h` in CSS px; shared by every wave):**

| lod | h | surfaces | what draws | ink |
|---|---|---|---|---|
| 3 | ≥ 110 | locker 150, level-up card, pickers' preview | everything: rim slivers, 3-4 folds per cloth part, laces, rope twists + tassel strands, hat side ribs, hem-fold shadows, catch-light + lid shadow, blush, hammer claw split, lantern bars + finial, `screen` lantern tint | `h × 0.0105` capped at 3.6 px |
| 2 | 48-109 | game card 64, course faces 64×84, tutorial 64, leaderboard busts at the top of the range | tones + shade band + highlight sliver, one cast shadow per part, 2 folds, vest tapes, hoodie strings, zip, tufted tassels, iris + pupil, brows, nose, mouth, glow rings + lit patch (2 steps) | 1.0 px |
| 1 | 30-47 | HUD face, speech-sheet busts (36-44) | base + one shade band per part, limb shade stripe, eyes as ink dots with a spark, mouth, rope as a band, lantern as a glass block + one halo | 0.85 px |
| 0 | < 30 | the street (22-26) | flat tones + ink, no clip at all (`needClip`), bigger eye dots, no mouth, hammer head in the highlight tone, one glow ring | 0.7 px |

### Wave 1: the crisp base (painter core + every existing part at the flat level)

- **Code:** `Pen.part(path, fill, inner, line)` (fill → clip → inner → ink on top), `Pen.band` (half-plane
  fillRect inside the clip), `Pen.crescent` (two offset ellipses), `Pen.limb(ang, len1, bend, len2, w, mat,
  cap, capBefore)` replacing `Pen.jointed` (same signature; three-pass capsules, ink / fill / clipped shade
  stripe; per-segment so no self-intersection; light rotated into the limb frame), `mat()` with a per-look cache,
  the LOD ladder and the ink table, the `needClip` gate. Delete `Pen.grad` and the five per-frame gradients
  (`shirtG/pantsG/skinG/hairG/hatG`) and the hammer's gradient; keep the iris radial for this wave.
- **Parts changed:** torso, tee/hoodie/polo bodies, vest panels, legs + boots, arms + hands, head skin + ears,
  all 9 hairs (fill → `b` + one band, the highlight ellipse becomes an `h` sliver), 3 hats, 3 beards, the 9
  props, 3 tools, the umbrella, the clipboard: every `pen.shape/circle/ellipse/rrect/poly` call becomes a
  `pen.part` with at most one shade band. Face features untouched. The mirrored facing flips `L.x`.
- **Guard:** add `clip()`, `getTransform()`, `globalCompositeOperation` to `makeCtx`; a draw-call counter
  (`fills + strokes + clips`). Pins: zero `createLinearGradient` at any size; `createRadialGradient` only from
  `roundEye` (count = open eyes) this wave; ink weight = 0.7 / 0.85 / 1.0 / `h×0.0105` at 26 / 40 / 64 / 300 px;
  the `clip` count at 26 px is 0 for the rep; `Pen.limb` draws the think pose (elbow −130) and the hands-on-hips
  fidget (elbow 112) without a point of the shade stripe leaving the capsule union; every pose × facing
  {1, 0.5, 0.08, −0.5, −1} × 4 builds draws without throwing (extend the wave-24 loop). Flip the pins that
  regex today's gradient lines (ears with `skinG`, hoodie `pen.grad`, hardhat `hatG`) in the same PR, each with
  its reason.
- **Growth:** +2.5 KB minified (painter) − 0.5 KB (gradients gone) ≈ **+2 KB** → 2810 of 2816 KB.
- **Cost:** ten street characters ≈ 10 × 63 calls, 0 gradients, 0 clips at lod 0 ≈ 630 calls/frame, below
  today's ~700 calls + ~90 gradient objects.

### Wave 2: the detail layer (lod 2 and 3)

- **Parts:** cast-shadow bands (brim across the forehead, head on the chest, belt on the pants), highlight
  slivers on every rounded part, fold strokes in `d` (2 at lod 2, 3-4 at lod 3: hoodie drape, jeans knee,
  sleeve crease at the elbow in the joint's local frame so they pose), hardhat centre rib + side ribs + brim
  underside band, cap seam + button, beanie ribbing, vest shoulder + chest tape with the brighter centre line
  and a zip pull, hoodie hood-back bunch + strings (still swinging with `p.hair`) + hem rib, polo placket,
  jeans fly + pocket arcs + turned cuffs, boots with tongue, toe cap, welted sole and three lace crosses,
  hammer claw, tape and ladder detail, fringe zigzag edges and one lock line per hair at lod 3, beard shade
  band, prop detail (mug steam etc. unchanged).
- **Guard:** draw-call counts pinned as ranges per LOD (rep front: 26 px 55-70, 64 px 110-135, 150 px 150-175)
  so a detail added to the wrong gate fails; no fold/lace/stitch strokes at lod 0 or 1; the brim shadow is one
  clipped fill inside the head part.
- **Growth:** **+4.5 KB** → 2814.5 KB (still inside the gate).

### Wave 3: the face in the new ink

- **Parts:** eye white + iris as `Pen.part`s (ink on top, lid shadow as a band), a flat two-tone iris with a
  darker rim replacing the radial gradient at lod ≤ 2 (the radial stays at lod 3 only, or goes entirely if
  the sheet reads the same); dot eyes at lod 0/1 as the street does today; blush, nose, mouths, brows, wink,
  smirk, happy eyes, closed eyes, glasses and shades in the ink table; elder lines. Nothing moves: `eyL/eyR/ey`,
  `my`, the feature slide `fx` and the ear tuck stay.
- **Guard:** gradients = 0 at h ≤ 109 for every look; mood/talk/blink pins unchanged; the wave-24 feature-slide
  pin unchanged.
- **Growth:** **+1 KB** → 2815.5 KB. **This is the last wave that fits the ceiling.**

### Wave 4: outfit pieces, part 1: the robe and the hood

- **New looks:** `top: 'robe'` (A-line body from the shoulders to a torn zigzag hem at y 104-110 with turned-fold
  shadows, slanted shade bands following the flare, bell sleeves drawn in the limb's end frame over the hand,
  a rope belt: ink under-stroke + rope stroke + darker lower edge + twist ticks (lod 3: cel-tall's alternating
  lozenges), a two-loop knot, two hanging ends with ties and tufted tassels) and `hat: 'hood'` (a peaked cowl in
  the head frame so it tilts and turns with `headXf`/`fx`, radiating folds, a pale rim on the lit edge of the
  opening, an arched near-black cavity over the skin with a faint chin plane at lod 3, two glowing eyes with
  one halo each; a mantle part in the body group with a front point and a torn edge). A hood hides hair, hat,
  beard and eyewear (the way spikes tuck under a hat today); mood and talk drive the eye glow (brighter on a
  grin, dimmer on a frown, a pulse while talking, still under reduced motion); the cavity slides with `fx` so
  the turn reads.
- **Guard:** hood × every pose × 4 builds × 5 facings draws; `hair/hat/beard/extra` draw nothing under a hood
  (fill counts equal across those looks); the cavity is drawn after the head skin and before the front-hair
  frame; the hem generator is deterministic (same points for the same seed); robe + vest draws the vest over
  the robe without a gap; normalize keeps every existing saved look byte-identical (`top`/`hat` defaults
  unchanged).
- **Growth:** **+5 KB** → ~2820.5 KB: **raise `SHIPPED_CEILING.localBytes` deliberately in this PR** (the
  budget test's own convention: a dated reason on the constant), or land the offset wave first (below).

### Wave 5: outfit pieces, part 2: satchel, lantern, boots

- **New looks:** `bag: 'satchel'` (a new look key, default `'none'`: stitched strap across the chest drawn
  after the torso and before the arms, under a vest or the robe's belt; a buckled flap bag on the far hip
  drawn after the torso), `prop: 'lantern'` in the back hand (bail, cap, caged glass with a near-white core,
  base, finial + bars at lod 3; hangs straight from the hand's world point, not rotated with the forearm; the
  glow: one source-over radial in the air at lod ≥ 1 + three flat rings, drawn after the body group and before
  the head; two stepped lilac patches clipped inside the robe/sleeve/lower hood toward the lantern at lod ≥ 2;
  the `screen` radial inside each lit cloth part at lod 3 only), tall laced boots for the robe look (the work
  boots of wave 2 for everyone else).
- **Rules:** `lantern` and `umbrella` share the prop slot, so rain wins (`wxLook` overrides); the lantern's
  pulse is still under reduced motion; a pose that swings the back arm behind the torso (`cross`, `cringe`)
  drops the lantern like `p.noProp` drops props today.
- **Guard:** exactly one `createRadialGradient` per lantern carrier at lod ≥ 1 and none at lod 0; the glow
  pass sits between the body group's `ctx.restore()` and the head's `ctx.save()`; strap before arms; satchel +
  every prop + every pose draws; a look with `bag` absent normalizes to `'none'`.
- **Growth:** **+4 KB** → ~2824.5 KB.

### Wave 6: wiring: pickers, street personas, docs

- **roof-rep.js** (locker picker) and **game-sprite.js** (game-card picker): a Hood entry in the Hat row, Robe
  in the Top row, Lantern in the Prop row, a new Bag row (none / satchel), with the copy "a hood covers hair,
  hat, beard and glasses"; `PERSONA_OUTFIT` on the street gives the hooded set to the personas Jo picks
  (proposal: `nightShift` carries the lantern after the evening tint, `historic` and `nosolicit` wear the
  robe + hood, and an autumn/Halloween-week event dresses every doorway homeowner in it, through `seasonLook`
  so saved looks never change); the demo seed stays as it is (no new keys needed).
- **Docs:** the dated note in `documentation/projects/` (this plan, the contact sheet, the LOD table, the
  measured costs) linked from INDEX.md; `CHARACTER-STYLE-BAR-2026-10-25.md` gets its "Open decisions" answered
  in place.
- **Guard:** the picker rows (both files), `PERSONA_OUTFIT`, `seasonLook` precedence (umbrella over lantern),
  `check-vault-index.js`.
- **Growth:** **+1.5 KB** across roof-rep.js and game-sprite.js → ~2826 KB.

### Wave 7 (only if Jo funds views): the true side view

- A second geometry set per part, switched in below |facing| 0.5 inside wave 24's `TURN_MS` squeeze: profile
  head (nose and brow on the silhouette, one eye, ear, brim longer in front), 9 hairs, 3 hats, 3 beards, the
  hood with its opening as a forward arch and one eye, torso and vest side panel, robe side, far limbs a shade
  darker, the far arm split so the prop is held out in front (prop hand = near hand), profile boots with a
  toe; drawn facing +x and mirrored with `L.x` flipped. The walking street rep becomes a true profile.
- **Guard:** every look × every pose at facing 0.3 draws; the side view's draw-call counts; the near hand holds
  the tool.
- **Growth:** **+10-14 KB** (a geometry set for the whole catalogue): needs its own deliberate ceiling raise
  (→ ~2838 KB). A back view (ref 2's turnaround) is a third set of similar size, later.

### Wave 8 (conditional): the per-character offscreen cache

Only if a phone profile after wave 5 shows the leaderboard (ten 48-64 px busts) or the street missing 30 fps:
cache each character's still parts on an offscreen canvas per pose bucket and redraw the head (blink, gaze,
mouth) and the limbs live. Measured counts say it is not needed (see cost below). +1 KB.

### Offset wave (optional, any time after wave 3): retire the 32×32 pixel avatar

`game-sprite.js`'s `build()`/`outline()` painter (the game card's fallback and both pickers' option tables) and
`roof-rep.js`'s `paint()` fallback are the only pre-chibi drawings left; both pickers' tables can draw chibi bust
crops instead. Recovers **~5-6 KB minified** (game-sprite.js is 9.0 KB in all; `paint()` is 1.0 KB), roughly the
cost of wave 4, and closes the style-bar inventory's "held to the bar or retired" line.

## 3. Budget

- **Bytes:** shipped local scripts are **2808 of 2816 KB** today (8 KB slack; `tests/dashboard-boot-budget-2026-10-03.test.js`).
  chibi.js is 36.8 KB minified. Waves 1-3 add ~7.5 KB and fit; wave 4 crosses the gate (~+5 KB), waves 5-6
  another ~5.5 KB, so the restyle lands at ~2826 KB (a 10 KB raise, or 5 KB with the offset wave); the side view
  is ~+12 KB on top (~2838 KB). Sanity check: crisp-chibi's whole page script, harness and both side views
  included, is 30.2 KB minified; the port adds a painter and per-part shading data to an existing catalogue,
  not a second catalogue, except in wave 7.
- **Per frame, ten street characters at 22-26 px (lod 0):** ~63 calls each, zero gradients, zero clips
  (`needClip`) ≈ **630 draw calls/frame**, against today's ~700 calls + ~90 gradient objects (five per-frame
  linears + an iris radial per open eye). Headless Chromium software raster measured 0.4-0.9 ms per draw at
  this call count, so 5-9 ms of a 33 ms frame; a phone's GPU canvas is command-bound in the same way. The game
  card (one at 64 px, lod 2, ~125 calls), the leaderboard (ten busts at 40-64 px, ~90-125 calls each ≈ 1.1k
  calls, about 1.6× today, under the 30 fps cap with the rest-when-offscreen loop) and the locker (one at
  150 px, ~170 calls) need no cache. A lantern carrier adds one radial gradient, three `lighter` fills and two
  clipped patches.

## 4. Risks

1. **The guard's exact-source pins.** Many of the 103 pins regex today's gradient lines (ears with `skinG`,
   the hoodie `pen.grad`, the hardhat `hatG`, the eye radial). Each wave flips only the pins its change
   invalidates, in the same PR with the reason, and adds the new ones first (bug fix = failing test first).
2. **A half-restyled look in production between waves.** A push to `main` deploys; wave 1 is deliberately a
   complete pass over every part at the flat level so nothing is mixed, and wave 2 should follow within days.
3. **Dark palette on dark panels.** The robe browns, the near-black cavity and the purple glow sit on the game
   card's `#1b2230` and the leaderboard rows; separation comes from the ink and the pale hood rim, so the sheet
   must include the navy panel and the yard green at 64 and 26 px. `lighter` washes out on a light page: the
   air glow is source-over.
4. **Self-intersecting limbs at high bend** (cel-chibi's fault): avoided by per-segment capsules; pinned on the
   think pose and the hands-on-hips fidget.
5. **Z-order of lit props** when a pose swings the back arm behind the torso: handled by the `noProp`-style drop
   in wave 5; a raised lantern (`armLUp`) draws after the head like the umbrella does.
6. **Prop-slot conflicts on the street:** lantern vs umbrella vs persona props; precedence is written into
   `wxLook`/`seasonLook` in wave 6 and pinned.
7. **ES5 and the vm guard:** the cel/paint prototypes are ES2015 with `Path2D` and `getTransform`; nothing of
   that lands. The painter is written ES5 and the guard's `makeCtx` grows `clip()` in wave 1.
8. **Phone cost is measured, not profiled:** the counts and headless timings are strong but a real phone profile
   of the street (ten characters + weather) after wave 2 decides wave 8.
9. **Byte ceiling:** waves 4-7 cannot land without a deliberate raise (or the offset wave); Jo decides which.
10. **The hood hides identity:** a hooded rep shows no hair, hat, beard or glasses; the pickers must say so, and
    the leaderboard bust of a hooded rep is a cowl with two lights (fine for a homeowner, a choice for a rep).

## 5. Open questions only Jo can answer

1. **Proportions.** The judges did not split: all three say keep the chibi. Confirm, and confirm "keep the head
   at (50,42) r 29 exactly" (zero crop/gaze retune) rather than crisp-chibi's r 26 at (50,38).
2. **Palette darkness vs the brand.** May homeowner outfits go as dark as the references (deep browns, a
   near-black cavity, a purple glow) on the navy `#1a3057` / `#1b2230` panels, or should the hooded set be
   lighter (or an NBD variant: a navy cloak with an orange-glass lantern)? Character colours are free by the
   brief; this is about contrast on the product's dark surfaces.
3. **Who gets the new outfit.** Every homeowner persona, only a few (proposal: `nightShift` lantern at evening,
   `historic` + `nosolicit` robe + hood), or only a seasonal/Halloween-week event street? And do reps get hood,
   robe, lantern and satchel in the locker and game-card pickers, knowing a hood covers their hair, hat, beard
   and glasses?
4. **Views.** Fund the true side view (wave 7: a second geometry set for the whole catalogue, +10-14 KB and its
   own ceiling raise) now, later, or stay on the pseudo three-quarter turn? A back view for reference 2's full
   turnaround would be a third set.
5. **The byte ceiling.** Raise 2816 → ~2826 KB across waves 4-6 (→ ~2838 with the side view), or retire the
   32×32 pixel avatar first (~5-6 KB back) to pay for most of it?
6. **The rep's eyes.** Keep today's big shiny iris with the highlight and blush (two judges asked for this) over
   crisp-chibi's white-disc eyes? Recommended: keep today's.
7. **The vest.** crisp-tall drew the hi-vis vest orange; saved looks use lime `#C6E11C`. Keep lime as the default
   and add orange as a vest colour option, or leave the vest alone?
