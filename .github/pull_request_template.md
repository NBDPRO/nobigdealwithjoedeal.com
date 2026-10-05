<!-- PR template — delete sections that don't apply. -->

## Summary

<!-- 1-3 bullets: what does this change and why? -->

## Type

- [ ] Bug fix
- [ ] Feature
- [ ] Security fix
- [ ] Refactor / cleanup
- [ ] Docs only
- [ ] CI / tooling

## Security self-check

- [ ] Does this touch `firestore.rules`, `storage.rules`, or any file under `/functions/integrations/`? If so, are there matching assertions in `tests/smoke.test.js` and/or `tests/firestore-rules.test.js`?
- [ ] Does this add a new Cloud Function? If so, does it have:
  - [ ] `enforceAppCheck: true` (unless public-facing homeowner endpoint — justified below)
  - [ ] Rate limit (via `callableRateLimit` or `httpRateLimit`)
  - [ ] Auth check (`requireAuth` / `request.auth.uid`)
  - [ ] Owner / tenant scoping before any Firestore read or write
- [ ] Does this add a new Firestore collection? If so:
  - [ ] Is the rule default-deny with explicit allow?
  - [ ] Is there a rules test?
- [ ] Does this introduce a new sub-processor (HOVER, Regrid, etc.)?
  - [ ] If yes, update `docs/privacy.html` sub-processor list
- [ ] Does this add any new PII field to a Firestore doc?
  - [ ] If yes, does the audit trigger redact it? (see `functions/audit-triggers.js`)
- [ ] Does this add any new `onclick=` inline handler? (should be `data-action` delegated — see H-1 in audit)

## Test plan

- [ ] `node tests/smoke.test.js` passes locally
- [ ] (if rules/integrations changed) `cd tests && firebase emulators:exec --only firestore --project nbd-rules-test 'node firestore-rules.test.js'` passes
- [ ] Manual: <describe what you clicked + what you verified>

## Deployment notes

<!-- Does this require any of the following to go live?
- New secret? If so, which one + how to get it
- New index? Deploy indexes before functions
- External config (Stripe webhook URL, Cal.com webhook URL, etc.)?
- Feature flag? Default state?
-->
