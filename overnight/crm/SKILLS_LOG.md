# SKILLS_LOG — GitHub discovery (Phase 5)

## Sweep 1 (2026-11-06 09:05 ET, ~8 min)
Queries (gh search repos): "claude code skill accessibility audit" (0), "SKILL.md playwright testing" (0),
"firestore emulator playwright auth" (0), "firestore listener leak detection" (0), "accessibility skill claude" (0),
"playwright skill" (5). Multi-word queries return nothing from `gh search repos`; use 2-word queries next time.

| Candidate | SHA | ★ | Last push | License | What | Verdict |
|---|---|---|---|---|---|---|
| lackeyjb/playwright-skill | dd47a6a | 3269 | 2026-11-01 | MIT | Claude skill: run ad-hoc Playwright scripts via run.js + helpers | USEFUL-LATER. Read SKILL-adjacent code (run.js, lib/helpers.js, package.json): no install hooks, no non-GitHub network calls, writes only to os.tmpdir(). Not adopted: scripts/audit/harness.js already covers login/sweep/axe, and its `setup` runs `npx playwright install` (memory: a failed install prunes this machine's browsers). |
| anthropics/skills | — | 188k | 2026-10-28 | none reported by gh | Official skill collection | Not cloned: no skill there targets Firebase/vanilla-JS auditing beyond what's installed. |
