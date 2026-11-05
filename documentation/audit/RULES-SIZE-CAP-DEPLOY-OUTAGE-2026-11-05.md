# Rules size cap stopped every deploy (2026-11-05)

## What happened

#2792 (receipt inbox, server half) took the commented `firestore.rules` from
259,967 to 263,469 bytes. The Firebase Rules API refuses a ruleset whose sources
are 262,144 bytes or more:

```
Request to https://firebaserules.googleapis.com/v1/projects/nobigdeal-pro:test
had HTTP Error: 400, Total size of sources must be smaller than 262144.
```

From run 41957745699 (2026-11-05 02:50Z) on, every "Firebase deploy" run on
main failed at **Deploy Firestore rules (pro)**. The step's 3-try loop read the
400 as a "likely transient auth race", so the message says nothing about size.

- **Still shipped:** Hosting deploys first, so the public site and CRM front
  end kept updating (`/version.json` showed 8134293c, including #2827).
- **Did not ship:** Firestore rules, indexes, Storage rules and Cloud Functions,
  from every merge after 51ef8062 (the last green deploy, 00:56Z).

## Why no gate caught it

The emulator never applies the cap: all the rules suites passed against the
263 KB file. Nothing in CI measured the file.

## Fix (#2869)

- `scripts/strip-rules-comments.js` removes lines that are only a `//`
  comment (about 55% of the file) from the **uploaded copy** only, which comes
  to 117,783 bytes.
  - A `//` after code or inside a string is kept.
  - `--write` refuses if any code line changed.
- The deploy step strips the copy before uploading and restores the readable
  file on exit. The rules tests before it still run against the full file.
- The required **Node syntax check** job runs `--check`. It fails if the
  stripped copy reaches the cap and warns at 240,000 bytes.
- Proof: `tests/firestore-rules.test.js` was run on the emulator with
  `RULES_PATH` pointing at the stripped copy, and all 28 groups passed. A
  301 KB file with no comments makes `--check` exit 1.

## If it comes back

The `--check` warning means the rules *code* is approaching 256 KB. By then,
stripping comments no longer helps. Shrink the rules: factor out repeated
helper conditions. Splitting the file will not help, because the cap applies
to the total size of all sources.

## Update 2026-11-05 (afternoon): the index step was a second stop

With #2869 deployed, the rules step passed (117,861 bytes uploaded), and the next step failed with the same 400:
`firebase deploy --only firestore:indexes` compiles firestore.rules too, and it ran on the full file the rules step
had just restored. Storage rules and Cloud Functions are behind it, so they still did not ship (deploy for 590b24ab).
#2878 runs the same strip-and-restore in the index step, and
`tests/deploy-firestore-steps-strip-rules-2026-11-05.test.js` fails if any deploy step with a firestore target skips
it. Lane note: [NEXT_SESSION-2026-11-05-site-crm-speed](../projects/NEXT_SESSION-2026-11-05-site-crm-speed.md).
