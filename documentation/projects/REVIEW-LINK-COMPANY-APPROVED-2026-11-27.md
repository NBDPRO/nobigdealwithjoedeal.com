# Other companies' review link: from their profile, platform-approved (2026-11-27)

Jo's decision on 2026-11-27: "use each company's own link from their profile". He also asked to keep the "heavy guardrail" bar. This follows R12 (#3293), which made NBD always use its own link. The security review of R12 found that other companies still used the saved link of the team member who owns the lead. That was its Medium finding.

## What changed

- **Where the link comes from.**
  - The review-ask request (`setReviewAskProfile`) no longer accepts a typed link.
  - The server reads `companyProfile/{companyId}.brand.integrations.reviewUrl`. Only the owner or a company_admin can write that field.
  - The link is checked against the Google review allowlist (`review-ask-tenant-logic.js` `validateReviewUrl`).
  - If there is no valid link, the request is refused. It fails closed.
- **Approval.**
  - A platform admin approves through `manageReviewAskTenant approve`, the same S1 flow as the display name.
  - The approve step re-reads the profile link. The link must still be the one the company requested, and the one the admin was shown (`wouldFreeze.reviewUrl` / `expect`).
  - The approved copy lives in `review_ask_tenants/{companyId}.approved`. Only the server can read or write it: the rules' catch-all deny covers it, and rules §65 tests it.
- **After approval.**
  - Every send uses the approved link.
  - A later profile edit changes nothing until the company sends a new request and an admin approves it.
  - If nothing is approved, there is no ask and no link.
- **Audit.** Each sent row in `review_ask_sends` records the `reviewUrl` it used.
- **Portal button, rating response and agent review sprint** for other companies. This part is dark behind `REVIEW_LINK_APPROVED_ENABLED`.
  - Flag on: only the approved link (`companyReviewLink`). No approved link means no link.
  - Flag off: R12's rule (the rep's link, Google pages only).
  - NBD always gets its own link.

## Tests

- `tests/review-ask-tenant-2026-11-26.test.js`:
  - §A (request shape);
  - §F (the link comes from the profile, fail closed);
  - §G (approve re-checks the profile link; a company_admin cannot approve);
  - §H (an unapproved profile change and the rep's link never reach an email; the audit row records the link);
  - §I (`companyReviewLink`, flag on and off).
- `tests/firestore-rules.test.js` §65:
  - a company_admin may set its own profile link;
  - a sales rep may not;
  - no company role can create or merge the approved copy.

## Turn-on

1. Merge. Nothing changes: the flag is off, and the review ask for other companies is still dark (`REVIEW_ASK_TENANTS_ENABLED`).
2. For each company: it sets its Google review link in its company profile and sends its review-ask request. A platform admin checks the listing and approves it.
3. Set `REVIEW_LINK_APPROVED_ENABLED=true` in `functions/.env.nobigdeal-pro`, through a PR. Companies with nothing approved lose the portal review button until they are approved.
4. To roll back, set the flag back to `false`.
