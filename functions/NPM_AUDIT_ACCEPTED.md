# Accepted npm audit advisories

Last reviewed: 2026-08-05 (brace-expansion pin bumped 5.0.8 → 5.0.9 —
GHSA-rgw5-rvv9-x895, a HIGH covering 4.0.0–5.0.8 that bypassed the
prior CVE-2026-14257 mitigation, published upstream and turned CI red
repo-wide on an unchanged lockfile, same pattern as 2026-07-24. The
minimatch@^10.2.5 half of the pin pair is unchanged and 5.0.9 keeps
the 5.x export shape, so no runtime re-verification was needed beyond
the smoke suite.)

`npm audit` currently reports **7 MODERATE** vulnerabilities in
`functions/` (0 LOW, 0 HIGH, 0 CRITICAL). Every one is transitive
through the Google Cloud / Firebase Admin SDK chain — we do not
depend on any of these packages directly, and none of the vulnerable
code paths are reachable from our function handlers. CI therefore
gates on HIGH+ advisories, with this file documenting every accepted
lower-tier finding.

## Dependency chain (all transitive, all from Firebase Admin)

```
firebase-admin
  ├── @google-cloud/firestore
  │     └── google-gax ──┬── gaxios          ← uuid (moderate)
  │                      ├── retry-request    ← teeny-request ← uuid (moderate)
  │                      └── rimraf → glob → minimatch → brace-expansion  (HIGH — pinned, see below)
  └── @google-cloud/storage
        └── teeny-request     ← uuid (moderate)
```

## Resolved by pin — HIGH GHSA-mh99-v99m-4gvg (brace-expansion <= 5.0.7)

**Status: FIXED via `overrides`, not accepted.** Recorded here because
the pin is non-obvious and must not be reverted casually.

- DoS via unbounded brace expansion → out-of-memory process crash.
- Reached CI on 2026-07-24 as a **HIGH**, which the gate rejects (the
  same job passed hours earlier on an unchanged lockfile — the
  advisory was published mid-day, not introduced by a dep change).
- Chain: `google-gax → rimraf → glob → minimatch → brace-expansion`,
  locked at `brace-expansion@2.1.2`.

**Why the pin is a pair.** The pin now reads `5.0.12`
(2026-09-30: GHSA-6j4f-fj2g-mc7p and GHSA-qhr7-859c-m2p7, both HIGH, plus
GHSA-q2hr-2g5m-vwhr, MODERATE, extended the range to `< 5.0.12`. Same
export shape and deps as 5.0.9. The lock entry was spliced by hand: version,
resolved and integrity only.) Before that it read `5.0.9`
(2026-08-05: GHSA-rgw5-rvv9-x895 extended the vulnerable range to
`4.0.0–5.0.8`, so the original `5.0.8` pin itself became the finding).
There is still no patched 2.x/3.x/4.x backport. And `5.x` changed its
CommonJS export from a bare
function (`module.exports = expand`) to a named object
(`{ EXPANSION_MAX, EXPANSION_MAX_LENGTH, expand }`). Pinning
`brace-expansion` **alone** installs cleanly and passes `npm audit`,
then throws at runtime the moment any brace pattern is evaluated:

```
TypeError: (0 , brace_expansion_1.default) is not a function
    at braceExpand (minimatch/dist/commonjs/index.js:160)
```

`minimatch@9.0.9` expects the old shape. `minimatch@10.2.5` is the
release built against `brace-expansion@^5`, so both are pinned
together. `glob@10.5.0` declares `minimatch@^9.0.4` and is forced past
its range by the override — verified working, including brace
patterns (see below).

**Do not** "simplify" this to a single `brace-expansion` override, and
do not take `npm audit fix --force`: it offers `firebase-admin@10.3.0`,
which regresses multi-tenant + App Check.

**Verified before merge** (node 22, the functions runtime):

- `npm audit --audit-level=high` → clean (7 moderate remain, all below
  the gate and documented below).
- `minimatch` brace/range/negation patterns → correct results.
- `glob` incl. `{a,b}` brace patterns → correct despite the forced
  major.
- `rimraf`, `google-gax`, `firebase-admin`, `firebase-functions` → load.
- All 19 `integrations/*.js` modules → load (the CI step).
- `functions/index.js` → loads, **184 functions registered**.
- Repo smoke suite → 2690 passed, 0 failed.

**Remove this pin** once `google-gax` ships a `rimraf`/`glob` chain that
resolves `minimatch@10` + `brace-expansion@5` natively; then re-run the
verification list above.

## Advisories

### ~~LOW — GHSA-vpq2-c234-7xj6 (@tootallnate/once < 3.0.1)~~ — RESOLVED UPSTREAM

**No longer reported** as of the 2026-07-24 re-audit; the upstream
`http-proxy-agent` chain described below finally propagated. Kept for
history — delete on the next dependency-review sprint.

- Incorrect Control Flow Scoping (CWE-705).
- CVSS 3.1 `AV:L/AC:L/PR:L/UI:N/S:U/C:N/I:N/A:L` = **3.3 LOW**.
- Requires LOCAL code execution. A Cloud Functions runtime is not
  a shell environment; reaching this code path requires the attacker
  to have already compromised the function process.
- `@tootallnate/once` is abandoned upstream. Fix requires a fresh
  release of `http-proxy-agent` that drops the dep, then propagation
  through `teeny-request`, `retry-request`, `google-gax`, and
  `@google-cloud/firestore`. That upstream chain has not completed.

### MODERATE — GHSA-w5hq-g745-h8pq (uuid < 11.1.0 in v3/v5/v6)

- `uuid.v3/v5/v6` with a custom `buf` argument skips a bounds check
  and can write past the buffer end.
- **Not reachable from our code.** Grep of `functions/` for
  `require('uuid')` and `uuid.v[3-6]` returns zero hits. The
  vulnerable entry points are only called internally by
  `google-gax` / `gaxios` / `teeny-request`, none of which invoke
  v3/v5/v6 with a caller-supplied buffer.
- Upstream fix shipped in `uuid@11.1.0`. The Google Cloud SDK chain
  has not yet picked it up — `firebase-admin@13.x` still resolves
  `uuid@9.x`. Downgrading `firebase-admin` to 10.1.0 (the only
  version `npm audit fix --force` offers) would regress multi-tenant
  and App Check APIs.

### ~~MODERATE — GHSA fast-xml-parser XMLBuilder injection~~ — RESOLVED UPSTREAM

**No longer reported** as of the 2026-07-24 re-audit (`@google-cloud/storage`
picked up a patched `fast-xml-parser`). Kept for history — delete on the
next dependency-review sprint.

- XML comment / CDATA injection via unescaped delimiters in
  `fast-xml-parser`'s XMLBuilder API.
- **Not reachable from our code.** We do not import
  `fast-xml-parser` directly; it is only used by
  `@google-cloud/storage` to parse GCS REST XML responses, which
  are trusted server-to-server payloads. We never hand user input
  to any XMLBuilder.

### (informational) follow-redirects was already patched

`follow-redirects@1.15.11` in the lockfile post-dates the fix for
GHSA-r4q5-vmmm-2653 (patched in 1.15.4).

## CI gate

CI runs `npm audit --audit-level=high` in `functions/`. Any HIGH
or CRITICAL advisory fails the build. MODERATE and LOW advisories
listed above are accepted and tracked here.

If a new MODERATE+ advisory appears that is NOT in this file:

1. Check if the vulnerable code path is reachable from our
   handlers (grep `functions/` for the package name; trace the
   call chain from dep-tree root).
2. If unreachable, add it to this file with a short justification
   and the exploitability analysis.
3. If reachable, treat as a P1 — even MODERATE can be exploitable
   when the code path is in-band.
4. On the next dependency-review sprint, re-run `npm audit` and
   remove entries that have upstream fixes picked up.
