# DESIGN.md — how NBD looks, for anyone (or any AI) building UI here

Read this before touching a page or screen. It describes the design system
**as the code actually has it** (extracted 2026-10-01, with file paths), and
the rules CI enforces. If this file and the code disagree, the code and its
tests win. Fix this file in the same PR.

There are **three visual systems**. Find out which one you're in before you
pick a color.

| Surface | Where | Look |
|---|---|---|
| Marketing site | `docs/*.html` (not `docs/pro/`) | Navy and orange, Bebas Neue display with Montserrat body, light pages with navy chrome |
| NBD Pro, customer-facing | `docs/pro/portal.html`, `estimate-view.html`, documents and PDFs | Warm paper (`nbd-brand.css`), Barlow Condensed with Barlow, **not theme-aware** |
| NBD Pro, rep dashboard | `docs/pro/dashboard.html`, `customer.html`, other app views | Themeable (`theme-system.css`, about 60 `[data-theme]` palettes); default `nbd-original` is dark navy |

`/sites/**` and `/tools/**` are a separate B2B system (orange `#C8541A`).
Leave them alone unless the task is about them.

## Color

**The brand orange is `#BD5728`.** Hover and deep: `#A14A22`. Light:
`#DD875F`.
- These were re-measured from the logo in 2026-09.
- `#E8720C` and `#F08030` are the old oranges. Never reintroduce them.
- `tests/marketing-polish-contract.test.js` pins this.

### Marketing site

There's **no shared token file**. Each page declares its own `:root`. Copy the
homepage block (`docs/index.html` ~38–51) exactly:

| Token | Value | Use |
|---|---|---|
| `--navy` | `#1a3057` | Brand navy |
| `--navy-dark` | `#12223d` | Nav, hero, body text on light |
| `--navy-mid` / `--navy-light` | `#1a3260` / `#243f7a` | Gradients, hovers |
| `--orange` / `--orange-dark` / `--orange-light` | `#bd5728` / `#a14a22` / `#dd875f` | CTAs, accents |
| `--off-white` | `#f5f3ef` | Section backgrounds |
| `--gray` | `#5d6673` | Muted text. Never `#6b7280` (the contract test fails) |
| `--light-gray` | `#e8e5e0` | Lines, cards |

### NBD Pro, customer-facing

From `docs/pro/css/nbd-brand.css`, scoped to `.nbd-brand` and
`[data-nbd-brand="true"]`:

- `--nbd-bg #faf8f5`, `--nbd-bg-elevated #fff`, `--nbd-ink #1a1612`,
  `--nbd-ink-muted #6b6357`, `--nbd-orange #BD5728` ("never change"),
  `--nbd-orange-deep #A14A22`.
- Status: success `#16a34a`, warn `#d97706`, danger `#dc2626`, info
  `#2563eb`. Each has a `-soft` variant at 10% opacity.
- `tests/visual/brand-tokens.spec.js` requires:
  - the portal and estimate view load `nbd-brand.css`;
  - they carry `data-nbd-brand="true"` and `class="nbd-brand"`;
  - the body renders `#faf8f5` on `#1a1612` in Barlow.

### Rep dashboard

Use the **short theme tokens**, never literals, so every theme works:
- `--orange` (accent), `--bg`;
- surfaces `--s`, `--s2`, `--s3`;
- `--br` (border), `--t` (text), `--m` (muted);
- `--green`, `--red`, `--gold`, `--blue`.

Some themes are light (paper, ghost, lofi, typewriter, ink). Test a new
screen in `nbd-original` **and** one light theme. `tests/theme-contrast.test.js`
and `crm-theme-contract.test.js` guard this.

## Type

- **Marketing:** fonts are self-hosted (`docs/assets/css/nbd-fonts.css`).
  - Display: **Bebas Neue**.
  - Body: **Montserrat**.
  - Accent: Dancing Script, sparingly.
  - Section titles: Bebas `clamp(2rem, 3.5vw, 3rem)`, letter-spacing `.03em`.
  - Buttons and labels: 700–800 weight, uppercase, about `.85rem`, `.06em`
    tracking.
  - Eyebrows: `.72rem`, 800 weight, `.16em` tracking.
- **NBD Pro:** **Barlow Condensed** (display, logo) with **Barlow** (body).
  - Brand scale: 11/13/15/18/22/28/36/48px.
  - Dashboard scale: `--fs-2xs`…`--fs-4xl` (9–24px).
- Don't add a new font family. The CSP only admits Google Fonts or
  self-hosted fonts, and an unloaded face silently falls back. The 2026-08
  sweep found `.qlf-btn` asking for a Barlow Condensed that page never loaded.

## Space, shape, motion

- **Marketing:**
  - Radii are **8px** and **100px** (pills) only. The contract enforces this.
  - Sections are `padding: 80px 40px`.
  - Content max-width: 1200 for hubs, 1000 for areas, 900 for service pages.
- **NBD Pro:**
  - 4px grid: `--nbd-space-*`, `--sp-*`.
  - Radii: 4/8/12/18/999 (brand) and `--r-xs`…`--r-2xl` (dashboard).
  - Shadows: `--nbd-shadow-sm/md/lg`, warm and low.
  - Motion timings: `--t-fast/mid/slow`. Respect `prefers-reduced-motion`.
- **Breakpoints:**
  - **768px** is the mobile breakpoint; the sticky CTA bar collapses there.
  - The nav collapses at **1024px** (contract-enforced).
  - 640 and 480px also recur.
  - Phones are tested at **412 and 360px**.

## Appearance engine (how reskins work)

The rep dashboard's look is set by four settings on `<html>`, each
independent of the others:

| Setting | Controls | Set by |
|---|---|---|
| `data-theme` | Colors (the token line in `theme-system.css`, plus the theme's registry entry in `theme-engine.js`) | `ThemeEngine.apply()` |
| `data-density` | Spacing | prefs boot |
| `data-shape` | Corner radius, elevation, motion character | `shape-preboot.js` before paint; `dashboard-ui-prefs-boot.js` |
| `data-motion="reduce"` | The app's own reduced-motion switch, alongside the OS setting | Comfort tab |

**Wallpapers and effects** are overlay types in `docs/pro/js/theme-overlays.js`
(`overlayLibrary`). A theme names one in its registry entry
(`overlay: { type, … }`). Every overlay must:

1. honor reduced motion (draw one still frame, no loop);
2. pause while the tab is hidden;
3. cap its frame rate;
4. fall back to static CSS when its tech isn't available.

`shader-gradient` (WebGL, 2026-10-01) is the reference implementation.

**A full reskin** is three pieces:

1. a theme registry entry;
2. its token line;
3. a CSS block scoped to `:root[data-theme="<id>"]`, for glass, glow, label
   style and so on.

Never restyle another theme from that block. The pilot is **Live Ops**
(`liveops`): an indigo/cyan WebGL wallpaper, frosted glowing cards and
uppercase mono labels. The plan is in
`documentation/projects/RESKIN-PLAN-2026-10-01.md`.

The CSP blocks CDNs, so any animation or graphics library is vendored under
`docs/`. Prefer hand-written WebGL or CSS (see `CLAUDE.md` "Code taste").

## Components (reuse; don't fork)

- **Marketing:**
  - Buttons: `.btn-primary` (orange), `.btn-secondary` (navy outline),
    `.btn-ghost` (on dark), `.btn-cal`, `.nav-cta`.
  - Other classes: `.eyebrow`, `.sec-title`, `.ico`, `.mobile-cta-strip`.
  - The 2026-08 sweep found `.btn-primary` with 9 paddings and 2 radii.
    Match the homepage's.
- **NBD Pro brand:** `.nbd-card`, `.nbd-card-flat`, `.nbd-btn` with
  `-primary` and `-ghost`, `.nbd-pill` with orange/success/warn/danger/info/
  neutral variants, `.nbd-eyebrow`, `.nbd-kv`, `.nbd-photo-grid`.
- **Dashboard:**
  - Buttons: `.btn`, `.btn-orange`, `.btn-ghost`, `.btn-red`, `.btn-green`,
    `.btn-sm`.
  - `.modal`, which becomes a **bottom sheet on phones**.
  - `.toast-*`.
  - `.logo-mark`: the orange "NBD" badge used in small headers instead of
    the wordmark.

## Logos and icons

- **Two favicon marks, assigned by path**
  (`documentation/audit/FAVICON-NORMALIZATION-2026-09-13.md`, enforced by
  `scripts/normalize-favicons.js --check` and `tests/favicon-contract.test.js`):
  - Homeowner pages: `/favicon.svg` and the apple-touch icon.
  - Pro, admin and tools pages: `/pro/favicon.svg`.
  - The portal, estimate view, sign and invoice pages use the **homeowner**
    mark.
- **Wordmarks:**
  - `nbd-logo.png` (white text, for navy chrome).
  - `nbd-logo-light-bg.png` (navy text, for light backgrounds and documents).
- PDFs use the square icon. Masters are in `brand/logo-pack-2026-09/`.

## Rules CI will fail you on

1. **No inline JS.** No `<script>` bodies and no `on*=` attributes
   (`script-src-attr 'none'`). New JS is an external file under
   `docs/assets/js/` or `docs/pro/js/`, loaded with `defer`.
2. **Generator-owned regions:** never hand-edit between `<!-- nbd:partial … -->`,
   `BLOG-*`, `OURWORK-*` or `TOWN*:START/END` markers. Edit the source and
   restamp it (see `CLAUDE.md`).
3. **Phones first.** Jo runs the business from an iPhone.
   - Tap targets must be **44px** or more (`--tap-min`).
   - Nothing may scroll sideways at 412 or 360px (`tests/e2e/phone-fit.spec.js`).
   - New screens need a phone-width check before they ship.
4. **Visual baselines:** login, register, pricing and landing are compared at
   1280, 768 and 375px (`tests/e2e/visual-regression.spec.js`).
5. **Escape every user-supplied value** that reaches `innerHTML`. Lead fields
   come from public forms.
6. **Copy rules** live in `documentation/brand/VOICE_BIBLE.md`. Also follow
   the Kentucky claim-wording rules: never "we handle or negotiate your
   claim" (`tests/claim-wording.test.js`).

## Before you call a UI change done

- Matches its surface's tokens: no new hex literals where a token exists.
- Checked at 412px or less, in `nbd-original` and one light theme, if it's
  a dashboard screen.
- Uses an existing component class rather than a near-copy.
- Adds no inline `style="…"` attributes. `tests/inline-style-ratchet-2026-10-01.test.js`
  caps the count so it only goes down, which is how screens become skinnable.
  A red theme gate prints the line to change and the fix
  (`theme-qa` suggests a passing shade; `crm-theme-contract` names the token).
- The gates in `CLAUDE.md` pass (partials, site integrity, inline-script
  check, plus the visual and phone specs if they cover the page).
