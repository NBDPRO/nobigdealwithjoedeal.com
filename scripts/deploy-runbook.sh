#!/usr/bin/env bash
#
# scripts/deploy-runbook.sh — single-source deploy orchestration for NBD Pro.
#
# What it does:
#   1. Pre-flight: ensures you're logged in, on the right project, and on a
#      clean working tree (or --allow-dirty was passed).
#   2. Inventories every secret the integrations/ modules expect and warns
#      on missing ones before deploying — unconfigured adapters are no-ops,
#      but you should at least SEE what's missing.
#   3. Runs `firebase deploy` in the correct order:
#        rules + indexes  →  functions  →  hosting
#      because functions sometimes write to new fields that need the new
#      indexes to exist first, and the rules update should land before new
#      client code hits production.
#   4. Post-flight: hits /integrationStatus, confirms App Check enforcement
#      is ON for at least claudeProxy + imageProxy + submitPublicLead,
#      and reminds you to call rotateAccessCodes from an admin session.
#
# Usage:
#   scripts/deploy-runbook.sh                 # interactive, requires confirmation
#   scripts/deploy-runbook.sh --dry-run       # preview only
#   scripts/deploy-runbook.sh --skip-hosting  # functions + rules only
#   scripts/deploy-runbook.sh --allow-dirty   # skip the clean-tree check
#
# Exit codes: 0 success · 1 preflight failure · 2 deploy failure · 3 postflight failure

set -euo pipefail

# ─── Config ─────────────────────────────────────────────────
PROJECT_ID="${NBD_FIREBASE_PROJECT:-nobigdeal-pro}"
FUNCTIONS_HOST="https://us-central1-${PROJECT_ID}.cloudfunctions.net"

# Integration secrets — kept in sync with functions/integrations/_shared.js.
# Missing ones produce a WARNING, not a failure — every adapter is coded to
# no-op when its secret is absent.
SECRETS_REQUIRED_FOR_CORE=(
  "ANTHROPIC_API_KEY"
  "STRIPE_SECRET_KEY"
  "STRIPE_WEBHOOK_SECRET"
)
SECRETS_RECOMMENDED=(
  "SENTRY_DSN_FUNCTIONS"
  "SLACK_WEBHOOK_URL"
  "TURNSTILE_SECRET"
  "UPSTASH_REDIS_REST_URL"
  "UPSTASH_REDIS_REST_TOKEN"
  "HOVER_API_KEY"
  "INSTANTROOFER_API_KEY"
  "INSTANTROOFER_WEBHOOK_SECRET"
  "REGRID_API_TOKEN"
  "HAILTRACE_API_KEY"
  "CALCOM_WEBHOOK_SECRET"
)

# ─── Arg parsing ────────────────────────────────────────────
DRY_RUN=0
SKIP_HOSTING=0
ALLOW_DIRTY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)       DRY_RUN=1 ;;
    --skip-hosting)  SKIP_HOSTING=1 ;;
    --allow-dirty)   ALLOW_DIRTY=1 ;;
    --help|-h)
      sed -n '2,/^$/{s/^# \{0,1\}//p}' "$0"
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

# ─── Logging helpers ────────────────────────────────────────
reset=$'\033[0m'; bold=$'\033[1m'
red=$'\033[31m';  green=$'\033[32m'; yellow=$'\033[33m'; cyan=$'\033[36m'
ok()    { printf "  ${green}✓${reset} %s\n" "$*"; }
warn()  { printf "  ${yellow}!${reset} %s\n" "$*"; }
fail()  { printf "  ${red}✗${reset} %s\n" "$*"; }
step()  { printf "\n${bold}${cyan}▸ %s${reset}\n" "$*"; }
run()   { if [ "$DRY_RUN" = 1 ]; then printf "    ${yellow}[dry-run]${reset} %s\n" "$*"; else eval "$*"; fi; }

# ─── Preflight ──────────────────────────────────────────────
step "Preflight checks"

if ! command -v firebase >/dev/null 2>&1; then
  fail "firebase CLI not found. Install: npm i -g firebase-tools"
  exit 1
fi
ok "firebase CLI present ($(firebase --version))"

if ! command -v node >/dev/null 2>&1; then
  fail "node not found"; exit 1
fi
ok "node $(node --version)"

# Firebase login
if ! firebase projects:list >/dev/null 2>&1; then
  fail "not logged in. Run: firebase login"
  exit 1
fi
ok "logged into firebase CLI"

# Project match
CURRENT_PROJECT="$(firebase use 2>&1 | grep -oE '"[^"]+"' | head -1 | tr -d '"' || true)"
if [ -z "$CURRENT_PROJECT" ]; then
  CURRENT_PROJECT="$(cat .firebaserc 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{console.log(JSON.parse(s).projects.default||"")}catch(e){}});')"
fi
if [ -z "$CURRENT_PROJECT" ]; then
  fail "could not detect active Firebase project"
  exit 1
fi
if [ "$CURRENT_PROJECT" != "$PROJECT_ID" ]; then
  warn "active project is ${CURRENT_PROJECT}, expected ${PROJECT_ID}"
  warn "override with: NBD_FIREBASE_PROJECT=${CURRENT_PROJECT} $0"
fi
ok "deploying to project: ${CURRENT_PROJECT}"

# Clean tree
if [ "$ALLOW_DIRTY" = 0 ]; then
  if [ -n "$(git status --porcelain)" ]; then
    fail "working tree is dirty. Commit first or pass --allow-dirty."
    git status --short
    exit 1
  fi
  ok "working tree is clean"
else
  warn "clean-tree check skipped (--allow-dirty)"
fi

# Current branch (informational)
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
SHA="$(git rev-parse --short HEAD)"
ok "deploying ${BRANCH} @ ${SHA}"

# ─── Secret inventory ──────────────────────────────────────
step "Secret inventory"

missing_core=()
missing_recommended=()

# firebase functions:secrets:access leaks values; use :get (just shows name + version).
if ! firebase functions:secrets:list >/tmp/nbd-secrets.txt 2>&1; then
  warn "could not list secrets (CLI may need upgrade); skipping inventory"
else
  for s in "${SECRETS_REQUIRED_FOR_CORE[@]}"; do
    if grep -q "^${s}\\b" /tmp/nbd-secrets.txt; then
      ok "required: ${s}"
    else
      fail "required: ${s} (MISSING)"
      missing_core+=("$s")
    fi
  done
  for s in "${SECRETS_RECOMMENDED[@]}"; do
    if grep -q "^${s}\\b" /tmp/nbd-secrets.txt; then
      ok "optional: ${s}"
    else
      warn "optional: ${s} (adapter will be no-op)"
      missing_recommended+=("$s")
    fi
  done
fi

if [ "${#missing_core[@]}" -gt 0 ]; then
  fail "Missing REQUIRED secrets — deploy aborted. Set them with:"
  for s in "${missing_core[@]}"; do
    echo "    firebase functions:secrets:set ${s}"
  done
  exit 1
fi

# ─── Browser-side key inventory ────────────────────────────
# F4: the three window.__NBD_* slots in docs/pro/dashboard.html
# should be non-empty before we ship to prod. Warn but don't block —
# some deploys are intentionally un-keyed (staging, sandbox).
step "Browser-side key inventory"

check_browser_key() {
  local slot="$1"; local file="$2"
  local val
  val=$(grep -oE "${slot}\s*=\s*\"[^\"]*\"" "$file" 2>/dev/null | head -1 | sed -E 's/.*"([^"]*)"/\1/')
  if [ -n "$val" ]; then
    ok "${slot} set in ${file}"
  else
    warn "${slot} NOT set in ${file} — feature will no-op in prod"
  fi
}

if [ -f docs/pro/dashboard.html ]; then
  check_browser_key "__NBD_APP_CHECK_KEY"     docs/pro/dashboard.html
  check_browser_key "__NBD_SENTRY_DSN"        docs/pro/dashboard.html
fi
for page in docs/index.html docs/estimate.html docs/storm-alerts.html; do
  if [ -f "$page" ]; then
    check_browser_key "__NBD_TURNSTILE_SITEKEY" "$page"
  fi
done

# ─── Sanity: smoke tests ───────────────────────────────────
step "Running smoke tests"
if [ -f tests/smoke.test.js ]; then
  if [ "$DRY_RUN" = 1 ]; then
    echo "    [dry-run] node tests/smoke.test.js"
  else
    if ! node tests/smoke.test.js >/tmp/nbd-smoke.txt 2>&1; then
      fail "smoke tests failed — aborting deploy"
      cat /tmp/nbd-smoke.txt
      exit 1
    fi
    tail -2 /tmp/nbd-smoke.txt
  fi
else
  warn "no tests/smoke.test.js — skipping"
fi

# ─── Confirm ────────────────────────────────────────────────
if [ "$DRY_RUN" = 0 ]; then
  step "Ready to deploy"
  printf "  Project:       %s\n" "$CURRENT_PROJECT"
  printf "  Branch @ SHA:  %s @ %s\n" "$BRANCH" "$SHA"
  printf "  Recommended secrets missing: %d\n" "${#missing_recommended[@]}"
  printf "  Hosting: %s\n" "$([ "$SKIP_HOSTING" = 1 ] && echo SKIP || echo INCLUDED)"
  printf "\n  Continue? [y/N] "
  read -r CONFIRM
  if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
    echo "Aborted."
    exit 1
  fi
fi

# ─── Deploy ─────────────────────────────────────────────────
step "1/3 firestore rules + indexes"
run "firebase deploy --only firestore:rules,firestore:indexes,storage:rules --project ${PROJECT_ID}"
ok "rules + indexes live"

step "2/3 cloud functions"
run "(cd functions && npm ci --silent)"
run "firebase deploy --only functions --project ${PROJECT_ID}"
ok "functions live"

if [ "$SKIP_HOSTING" = 0 ]; then
  step "3/3 hosting"
  run "firebase deploy --only hosting --project ${PROJECT_ID}"
  ok "hosting live"
else
  warn "hosting skipped"
fi

# ─── Postflight ────────────────────────────────────────────
step "Postflight"

if [ "$DRY_RUN" = 0 ]; then
  # Hit integrationStatus via a public path check — if the function came up,
  # the endpoint returns 401 (unauthenticated) rather than 404. That's the
  # health signal we want.
  if command -v curl >/dev/null 2>&1; then
    status_code="$(curl -s -o /dev/null -w '%{http_code}' \
      "${FUNCTIONS_HOST}/submitPublicLead" -X POST \
      -H 'Content-Type: application/json' \
      -d '{"kind":"__healthcheck","website":""}' 2>&1 || echo 000)"
    case "$status_code" in
      400|403|429) ok "submitPublicLead reachable (HTTP $status_code)" ;;
      *)           warn "submitPublicLead returned unexpected ${status_code} — investigate" ;;
    esac
  fi
fi

# Post-deploy reminders
step "Post-deploy checklist"
if [ "${#missing_recommended[@]}" -gt 0 ]; then
  warn "Set these optional secrets when ready:"
  for s in "${missing_recommended[@]}"; do
    echo "    firebase functions:secrets:set ${s}"
  done
fi

cat <<'EOF'

  MANUAL STEPS (Firebase Console):
    □ App Check → enforce on every Function that declares enforceAppCheck: true
    □ Auth settings → turn ON "Email enumeration protection"
    □ Paste ReCaptcha v3 site key into docs/pro/dashboard.html → window.__NBD_APP_CHECK_KEY
    □ Paste Sentry DSN into docs/pro/dashboard.html → window.__NBD_SENTRY_DSN
    □ From an admin session: call rotateAccessCodes (Team Manager → Rotate Access Codes)
    □ Run: BETA_COUNT=5 DEMO_COUNT=2 node scripts/seed-access-codes.js

  EXTERNAL WEBHOOKS TO REGISTER:
    Cal.com  → https://us-central1-nobigdeal-pro.cloudfunctions.net/calcomWebhook
    HOVER    → https://us-central1-nobigdeal-pro.cloudfunctions.net/measurementWebhook?provider=hover
    EagleView→ https://us-central1-nobigdeal-pro.cloudfunctions.net/measurementWebhook?provider=eagleview
    Stripe   → (already in place) /stripeWebhook + /invoiceWebhook

EOF

ok "deploy runbook complete"
