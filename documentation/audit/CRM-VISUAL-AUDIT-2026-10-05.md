# CRM visual audit — 2026-10-05

Jo asked for NBD Pro "to the next level visually… through and through", inside
the locked brand (orange `#BD5728`, navy, the live font stack). This is the
fast audit that decided where to start. Lane A covers the CRM internals:
Home/Today, Pipeline, the customer page, Close Board, Settings and Estimates.
The `/pro` landing page is a separate lane.

## How it was measured

- The local emulator was seeded with a realistic tenant: 12 leads across
  stages, 4 tasks and an owed invoice.
- Six screens were captured at 390×844 and 1440×900, in four looks: the
  default `nbd-original` in dark mode, the same theme in light mode,
  Daylight (light) and Jobsite (dark). That's 48 shots.
- The shots live outside the repo, in `C:\Users\jonat\visual-audit-A\before\`.
- Exemplar systems read for discipline: the Linear, Stripe, Raycast and Vercel
  DESIGN.md files from `VoltAgent/awesome-design-md`. From them:
  - depth comes from a surface ladder and hairlines, not from heavy shadows;
  - money uses tabular figures;
  - one accent, one primary action;
  - display text has a weight ceiling and tight tracking;
  - a written "Don't" list.

## Top 10, ranked by how many screens one fix reaches

1. **No type system in use.** The `--fs-*` scale exists, but nothing reads it
   (0 consumers). There are 130 rules at 9.5px or less, and sentence-length
   text is set in small caps (the Settings checkbox help).
   - Reaches: every screen.
2. **Every button shouts.** Filled orange, orange outline and bordered ghost
   all carry the same weight. The customer header has about 16 actions, with
   yellow, purple and green fills mixed in. There is no third, quiet tier.
   - Reaches: every screen.
3. **Flat surfaces.** The default Shape has `--elevation-card: none`, so cards
   are navy on navy, told apart only by a 1px border.
   - Reaches: every screen.
4. **Numbers don't line up.** No tabular figures on money or counts. The Close
   Board KPI zeros are painted blue, orange and green, with no meaning behind
   the colours.
   - Reaches: Home, Pipeline, customer page, Close Board.
5. **Radii drift.** 2, 5, 6, 7, 8, 9, 10, 12, 14 and 20px appear side by side.
   - Reaches: every screen.
6. **Noisy lines.** Dashed row rules, and a border on every element. Nothing
   tells a hairline (items) apart from a divider (groups).
   - Reaches: Home, Pipeline, Settings.
7. **Focus and contrast of the accent.** Plain `#BD5728` on the default navy
   is about 2.5:1. It is used as text (`.tp-go`, links) and as the only focus
   ring.
   - Reaches: every screen (accessibility).
8. **Motion is ad hoc.** `transition: all` survives in the primitives, there
   are no shared press/enter/exit durations, and the bouncy `--ease-out` is
   unused.
   - Reaches: every screen.
9. **Weak empty and loading states.** Close Board and Estimates show an emoji
   and one line. The Today card is blank while it loads. Pipeline columns say
   "DROP LEADS HERE".
   - Reaches: Close Board, Estimates, Pipeline, Home.
10. **Mixed icon languages.** Colour emoji (📋 🏠 💳) sit next to 1.5px stroke
    SVGs in the sidebar, buttons and headers.
    - Reaches: the sidebar plus every screen.

Also seen: `today-home.css` fell back to the retired `#e8720c` orange.

## What shipped

- **A1, the foundation.** Fixes 1 (tokens and type primitives), 3, 4, 5, 6, 7
  and 8 at the shared layer:
  - the FOUNDATION block in `docs/pro/css/ui-primitives.css`;
  - the "Foundation tokens", "Motion" and "Never do" sections of `DESIGN.md`;
  - `tests/ui-foundation-2026-10-05.test.js`.
- **The hero screens follow**, one PR each, in this order: Home/Today, Pipeline
  cards, the customer page header, Close Board. Each lists its before and after
  screenshot folders in its PR body.
