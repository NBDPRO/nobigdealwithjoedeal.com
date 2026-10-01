# NEXT_SESSION — 2026-10-01 part 2 (the 10-01 early-morning session)

Follows [NEXT_SESSION-2026-10-01](NEXT_SESSION-2026-10-01.md).
Jo asked for four hours of autonomous work, plus the reskin ("wallpaper grade
complete reskins … extreme quality") and the shared repos ("how much we can
learn / grow / improve"). Everything below is merged unless it says otherwise.

## §0 Read first

- **Reskins have a foundation now. Read `DESIGN.md` → "Appearance engine"
  and [RESKIN-PLAN-2026-10-01](RESKIN-PLAN-2026-10-01.md).**
  - A skin is three pieces: a registry entry, a token line, and a block
    scoped to `:root[data-theme="<id>"]`.
  - Live Ops (#1953) is the reference skin.
- **Shared shapes live in `docs/pro/css/ui-primitives.css`** (this PR):
  - classes `.ui-seg` (with `.is-on`), `.ui-row`, `.ui-panel`, `.ui-input`,
    `.ui-field-sm`;
  - JS toggles `.is-on` and `aria-pressed`, and never paints a state inline;
  - `.ui-panel` and `.ui-input` read the Shape role tokens (`--r-card`,
    `--r-input`, `--elevation-card`).
  - **Proof method:** serve `docs/` with JS off, expand every `<template>`,
    and diff the computed style of every element before vs after (scratch
    harness described in the PR). Run a positive control: a deliberate
    1px change has to show up.
  - **The dashboard's views live in `<template>`s.** A DOM-only snapshot
    misses them.
- **Inline-style ratchet** (`tests/inline-style-ratchet-2026-10-01.test.js`,
  #1955): the count only goes down. When you convert inline styles, lower
  the ceiling in the same PR.
- **The theme gates say what to change:**
  - `theme-qa` prints the ratio and a passing shade;
  - `crm-theme-contract` prints `file:line` and the token to use.
- **Shared counters:** parallel PRs collide on FLOORS, the manifest and
  script versions.
  - Two PRs that each bump 269 → 270 merge **textually clean** and are still
    wrong.
  - `node scripts/run-test-manifest.js --check` catches it. Run it after
    every merge of main.

## §1 Shipped (PR → what)

| PR | What |
|---|---|
| #1944 | D2D follow-ups, badge and list count only the newest knock per door (Jo) |
| #1945 | Jo's security checklist: verified owner email, verified-only email sender, public AI daily cap, Cal.com match by email, masked emails in logs, raster-only doc uploads, portal token in sessionStorage. Note: [SECURITY-CHECKLIST-2026-10-01](../audit/SECURITY-CHECKLIST-2026-10-01.md) |
| #1946 | `DESIGN.md`, plus Foursquare and Yellow Pages in the citation kit |
| #1947 | One-tap overdue-invoice reminder (KY pay-link hold respected) |
| #1948 | Review asks and referral texts honour STOP and unsubscribe |
| #1949 | Past Customers win-back list (won and not lost, 3+ months) |
| #1950 | Ask Joe ground rules: the claim is the homeowner's, KRS 367.620, no invented numbers |
| #1951 | Repo Lab borrows: call-analysis injection guard, CLAUDE.md "Code taste" |
| #1952 | Money: "Close last month" card. Note: [REPO-LAB-2026-10-01](../audit/REPO-LAB-2026-10-01.md) |
| #1953 | **Live Ops**: the first full-reskin theme (hand-written WebGL wallpaper, frosted glowing cards), opt-in |
| #1954 | 6:45am appointment brief to the owner, **dry-run until `MORNING_BRIEF_ENABLED=true`** |
| #1955 | Theme gates explain the fix; inline-style ratchet (verify merged) |
| this PR | `ui-primitives.css`: 79 dashboard surfaces off inline styles. The default look is unchanged except 1–2px radius normalisation, now following Shape presets. Live Ops styles the primitives |

## §2 Verify next session

- **Sentry 11 is still unconfirmed in production.** A positive-controlled log
  read on 10-01 found no `Sentry` lines in 2 days. It initializes lazily, so
  that's expected with no captured errors.
- **Morning brief dry-run:** after 06:45 ET, the `morningBrief` logs should
  show the built brief and no send.
- **Copycat watch** runs 10-01 12:15 UTC. A red result is real (see the prior
  handoff).
- **The `@stranger` E2E shard** flaked on main's #1952 CI ("Failed to
  authenticate" inside the emulator job). It's a known provisioning flake,
  not a code failure.

## §3 Open — Jo's answers

- **Next skin: Daylight (full-sun high contrast) or Jobsite (slate/copper)?**
  The mockups are the "NBD Pro skin candidates" canvas in Jo's claude.ai
  artifacts.
- Live Ops category: Professional or Sci-Fi? Make it Jo's default?
- Turn on `MORNING_BRIEF_ENABLED`.
- Install `claude-code-security-review`? Trial Impeccable (skill only,
  hooks off)?
- Cancel Semrush (never used; Search Console covers it). Claim the citation
  listings.
- Unchanged from [09-30 part 2 §2](NEXT_SESSION-2026-09-30-part2.md):
  - Yard Signs "Put them on the map";
  - Drive filing share;
  - the Thursday Reference Variable;
  - the Bland balance.

## §4 Next lanes

1. **ui-primitives batch 3: `customer.html`.** It has 85 skin-blocking sites
   on a different radius family (10px `--s2` panels, 8px `--s` cards). It
   doesn't load `dashboard-app.css`, so the role tokens fall back.
2. **JS-rendered surfaces.** Start with the most-used widgets and the
   pipeline card builders. `ui-primitives` classes plus the ratchet.
3. **Build the skin Jo picks**, design-first. The mockup is the brief.
