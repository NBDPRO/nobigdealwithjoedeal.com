# CRM reskin plan — 2026-10-01

## Jo's ask

Jo said:
- "full reskins … not just color options … wallpaper grade complete
  reskins of the CRM … in extreme quality";
- of a competitor's "AI Business OS" CRM he'd screenshotted: "love the look
  … nice and glowy with good color".

## What the code already had

The Repo Lab (the REPO-LAB-2026-10-01 audit note, landing in #1952) and this
pilot found that much of the foundation was already
built:

- About 60 color themes (`theme-system.css` and the `theme-engine.js`
  registry).
- `data-density` and `data-shape` settings, independent of color.
- An overlay and wallpaper engine (`theme-overlays.js`) that already
  respects reduced motion.

So a reskin **extends the engine** rather than replacing it. See
`DESIGN.md` → "Appearance engine".

## Why themes only recolored until now

About **4,700 inline style sites** in `docs/pro/js` (166 files) plus **848**
in `dashboard.html` fix spacing, borders, radius and shadow in code:

| File | Inline style sites |
|---|---|
| `document-generator-templates.js` | 336 |
| `vault-page.js` | 209 |
| `expenses.js` | 146 |
| `invoice-pipeline.js` | 142 |
| `widgets.js` | 140 |

Colors mostly flow through tokens; shape and texture mostly don't. A skin
can only restyle what reaches a class or token.

## Plan

1. **Pilot skin: Live Ops** (#1953, opt-in). This is the reference for
   every later skin.
   - A WebGL `shader-gradient` wallpaper overlay: half-resolution, 30fps,
     hidden-tab pause, a still frame under reduced motion, a CSS fallback
     without WebGL, and off in light mode.
   - Frosted cards with cyan edges and glow, uppercase mono labels, and
     glowing rings and bars.
   - Contrast passes AA with a wide margin: `--m` on `--s` is 8.31:1.
2. **Make the most-used screens skin-ready.** Convert inline shape and
   spacing to classes and tokens, highest traffic first: Home widgets,
   Pipeline cards, the customer page, Money, phone nav. Track the count of
   inline style sites as a ratchet so it only goes down.
3. **More skins on the same engine.** Proposed next:
   - **Daylight:** high-contrast for reading a phone on a roof in full sun.
   - **Jobsite:** slate, copper and texture.

   Each skin is a registry entry, a token line, a scoped CSS block and,
   optionally, an overlay.
4. **Design-first for each new skin.** Mock up Home, Pipeline, customer and
   phone views for Jo to react to before building. Figma is connected if Jo
   prefers marking up there.
5. **Quality gates per skin:**
   - contrast (`theme-contrast`);
   - the scoped-CSS pin (each skin's test, like
     `tests/theme-liveops-2026-10-01.test.js`);
   - phone-fit at 412 and 360px;
   - screenshots at 1280 and 390px.

## Open questions for Jo

- Should Live Ops stay in the Professional category or move to Sci-Fi?
- Should Live Ops become the default for Jo's own account once he's used it
  in the field?
- Which skin next: Daylight or Jobsite?
- Tools: no new paid tool is needed. Repo Lab ranks Impeccable as the
  design skill worth trialling, skill only with its hook off, for
  critique and polish passes.
