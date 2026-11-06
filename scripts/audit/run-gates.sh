#!/usr/bin/env bash
# scripts/audit/run-gates.sh — run the overnight CRM audit's pre-push gate list
# (overnight/crm/GATES.md) from the repo root and print PASS/FAIL per gate.
# Read-only: every gate is a --check / test. Usage: bash scripts/audit/run-gates.sh [outdir]
set -u
cd "$(dirname "$0")/../.."
OUT="${1:-${TMPDIR:-/tmp}/nbd-gates}"
mkdir -p "$OUT"
gates=(
  "syntax|node scripts/check-js-syntax.js"
  "integrity|node scripts/check-site-integrity.js --quiet"
  "vault|node scripts/check-vault-index.js --quiet"
  "chrome|node scripts/check-chrome-governance.js"
  "partials|node scripts/apply-partials.js --check --diff"
  "inline|node scripts/check-inline-html-scripts.js"
  "crmaudit|node scripts/crm-audit.js"
  "imgpriv|node scripts/check-image-privacy.js"
  "inlinetest|node tests/inline-html-scripts.test.js"
  "polish|node tests/marketing-polish-contract.test.js"
  "iconcss|node scripts/ensure-icon-css.js"
  "navcss|node scripts/ensure-nav-css.js"
  "manifest|node scripts/run-test-manifest.js --check"
  "jtcost|node scripts/strip-job-template-costs.js --check"
  "smoke|node tests/smoke.test.js"
  "smokebucket|node scripts/run-test-manifest.js --bucket smoke"
  "nodebucket|node scripts/run-test-manifest.js --bucket node"
)
fail=0
for g in "${gates[@]}"; do
  name="${g%%|*}"; cmd="${g#*|}"
  if env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy $cmd > "$OUT/$name.log" 2>&1; then
    echo "PASS $name"
  else
    echo "FAIL $name ($OUT/$name.log)"; fail=$((fail+1))
  fi
done
echo "failures: $fail"
