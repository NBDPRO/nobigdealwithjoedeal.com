# STATE — CRM overnight audit (crm/2026-11-06)

- Started: 2026-11-06 08:38 America/New_York (13:38 UTC). Note: launched in the morning, so STOP_AT = 2026-11-07 06:30 ET, wrap-up from 05:45 ET.
- Worktree: C:\Users\jonat\nbd-wt-crm · first branch: crm/2026-11-06-tooling from origin/main fed35123
- Phase: 0 (setup)
- HARNESS mode: pending (existing emulator rig found — see HARNESS.md)
- Current task: installs + baseline gates
- Done: worktree created
- Open PRs (mine): none yet
- Blockers: none
- Last clock check: 08:45 ET

## CONFIG (from the brief)
REPO=C:\Users\jonat\nobigdealwithjoedeal.com · WORKTREE_DIR=C:\Users\jonat\nbd-wt-crm · BRANCH_PREFIX=crm/2026-11-06
IN_SCOPE=docs/pro/**, satellites, docs/tools/index.html, tests/**, scripts/**, documentation/**
READ-ONLY=functions/**, firestore.rules, storage.rules, firebase.json, docs/** marketing, docs/sites/**
EMULATOR_PROJECT: see DECISIONS.md D-001

## Open PRs at start (not mine — do not touch their files)
- #2927	overnight/2026-11-05-eyebrow-wrap	fix(site): homepage eyebrows balance their wrap on phones
- #2926	overnight/2026-11-05-partners-dash	fix(copy): space the em dash in the /partners hero
- #2925	overnight/2026-11-05-areas-stats	fix(site): /areas hero stats as a 2x2 grid on phones
- #2924	overnight/2026-11-05-press-feedback	fix(site): press feedback scales buttons to 0.97 (was a 1px nudge)
- #2923	overnight/2026-11-05-cta-label	fix(site): phone Call/Text labels 9.9px to about 12px in the sticky contact strip
- #2922	overnight/2026-11-05-tap-targets	fix(site): phone tap targets for footer legal links, blog Read Article and partner CTAs
- #2921	claude/phase2b-bundles-on-2026-11-06	feat(crm): switch Phase 2b on — join the lazy ScriptLoader bundles at deploy
- #2920	claude/concat-sourcemaps-2026-11-06	feat(deploy): source maps for the joined _concat-*.js files
- #2919	overnight/2026-11-05-inspect-wordmark	DRAFT: /inspect header says the brand once (needs Jo's yes; rewrites a deliberate 2026-11-04 test)
- #2918	overnight/2026-11-05-howto-320	fix(pro): /pro/how-to fits a 320px phone (no sideways scroll)
- #2917	overnight/2026-11-05-pro-regions	fix(pro): last axe region notes on /pro/how-to and /pro/pricing
- #2916	overnight/2026-11-05-pro-tabpanel	fix(pro): /pro/ tour panels: valid element for role=tabpanel (axe aria-allowed-role)
- #2915	overnight/2026-11-05-pro-public-contrast	fix(pro): public Pro pages (how-to, register, pricing, terms) pass axe contrast, link, heading and main rules
- #2914	overnight/2026-11-05-login-legible	fix(pro): /pro/login phone text legibility (12px minimum; Best Practices 93 -> 96)
- #2913	overnight/2026-11-05-nav-pad	fix(site): header padding 16px at laptop widths on service hubs, /careers and /partners
- #2910	overnight/2026-11-05-morning-report	docs(overnight): final morning report + AFTER metrics + session summary
- #2909	overnight/2026-11-05-inspect-invalid	fix(site): /inspect form: every invalid field looks invalid, and clears when edited
- #2907	overnight/2026-11-05-a11y-misc	fix(a11y): last two axe findings across 298 pages (heading order, redundant alt)
- #2906	overnight/2026-11-05-btn-44	fix(site): primary CTA buttons at least 44px tall (was 42-43px on ~11 pages)
- #2740	claude/work-status-followup-3cl4lb	American Operator's official banners: the dark banner replaces the footer's small tile on every page, the orange banner under the About page's credential chips

### CRM-scope files touched by open PRs (avoid)
- #2921 tests/concat-bundles-2026-11-04.test.js
- #2921 tests/concat-sourcemaps-2026-11-06.test.js
- #2920 scripts/concat-shipped.js
- #2920 scripts/lib/sourcemap-concat.js
- #2920 tests/ci-manifest.json
- #2920 tests/concat-sourcemaps-2026-11-06.test.js
- #2919 tests/audit-small-fixes-2026-11-04.test.js
- #2918 docs/pro/how-to.html
- #2917 docs/pro/how-to.html
- #2917 docs/pro/pricing.html
- #2916 docs/pro/index.html
- #2915 docs/pro/css/pro-public-contrast.css
- #2915 docs/pro/how-to.html
- #2915 docs/pro/pricing.html
- #2915 docs/pro/register.html
- #2915 docs/pro/terms.html
- #2915 scripts/fix-pro-public-contrast.js
- #2914 docs/pro/login.html
- #2914 tests/e2e/visual-regression.spec.js-snapshots/login--mobile-375-chromium-linux.png
- #2914 tests/e2e/visual-regression.spec.js-snapshots/login--tablet-768-chromium-linux.png
- #2913 scripts/fix-nav-pad-laptop.js
- #2909 tests/inspect-cro-draft-2026-10-06.test.js
- #2909 tests/inspect-error-placement-2026-10-26.test.js
- #2909 tests/inspect-short-form-2026-10-06.test.js
- #2907 tests/a11y-contrast-sweep-2026-11-04.test.js
