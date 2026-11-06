#!/usr/bin/env bash
# scripts/audit/sweep.sh — run scripts/audit/harness.js over every route in
# overnight/crm/routes-a.txt (tenant A users) and routes-b.txt (tenant B) for
# owner@a.test, owner@b.test and rep@a.test. Read-only. Emulators + seed must be
# up (overnight/crm/HARNESS.md). Usage: bash scripts/audit/sweep.sh <outdir-windows-path>
set -u
cd "$(dirname "$0")/../.."
export MSYS_NO_PATHCONV=1
OUT="${1:-C:/Users/jonat/nbd-overnight-tools/runs}"
EV="JSON.stringify({len:((document.querySelector('.view.active')||document.body).innerText||'').length, nbd:/No Big Deal|nobigdealwithjoedeal|Joe Deal/.test(document.body.innerText), err:/something went wrong|failed to load|permission denied|missing or insufficient/i.test(((document.querySelector('.view.active')||document.body).innerText||'').slice(0,6000)), spinner:document.querySelectorAll('.spinner:not([hidden]),[aria-busy=true]').length, h:location.pathname+location.search+location.hash})"
for u in owner@a.test owner@b.test rep@a.test; do
  f=overnight/crm/routes-a.txt; [ "$u" = owner@b.test ] && f=overnight/crm/routes-b.txt
  node scripts/audit/harness.js --user "$u" --routes-file "$f" --out "$OUT/sweep-${u%%@*}-${u#*@}" --wait 2500 --eval "$EV" > "$OUT/sweep-$u.log" 2>&1
  echo "$u done $?"
done
