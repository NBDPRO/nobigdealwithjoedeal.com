# Sign-link panel (signing-ease lane), 2026-11-18

Jo's decisions Q48, Q59, Q60 (and Q61's 14-day link) in [TEMPLATE-DEEP-SWEEP-2026-11-17](TEMPLATE-DEEP-SWEEP-2026-11-17.md). Context: [CLAUSE-EVIDENCE-FOUNDATION-2026-11-18](CLAUSE-EVIDENCE-FOUNDATION-2026-11-18.md) (the evidence the signing paths record, unchanged here).

## The flag

`docSignPanelV1`, per person (`feature_flags/_default` or `feature_flags/{uid}`, only boolean `true` is on), **default OFF**, in `functions/flags-registry.js` `FIRESTORE_FLAGS`. The server reads it strictly in `createSignRequest` (`signPanelFlagForGate` in `functions/doc-evidence.js`: a read that fails is a retryable `unavailable`, never "off"); the client reads it with `NBDFlags.enabled('docSignPanelV1')`.

## Before (flag off, and still the behaviour with it off)

"Send for Signature" in the document viewer used `window.prompt` for an email. `createSignRequest` required a valid email that is on the lead's record and always emailed.

## What the flag changes

- **Server (`createSignRequest`).** New param `sendEmail:false` mints the link and returns `signLink` with `emailed:false`, no email sent, token `signerEmail` stored as `''`. It relaxes the email-required and `recipientOnRecord` checks **only** when the flag is on for the caller. With the flag off the param is ignored and the old checks run unchanged. Every other gate still runs on a link-only mint: owner check, document and path checks, evidence send checks, clause-set check, attic gate, strict flag reads, both rate limits (the daily cap is shared with the email sends). The token is single-use as always. Expiry is 14 days with the flag (7 without); the email copy states the real number. A new link also retires the older pending link of the **same document** (any type; contracts already retired other pending contract links), and the answer carries `supersededOld`.
- **Client panel (`docs/pro/js/sign-link-panel.js`, lazy).** The viewer's Send for Signature opens a panel instead of the prompt: a QR of the link (`NBDQr.svg`, the link and nothing else), **Text link** (an `sms:` link from the rep's own phone, held until `NBDPhoneShare.checkText` says yes; otherwise "Use Email or Copy link instead."), **Copy link**, **Email it** (address asked in the panel, validated, then the existing email path), **Make a new link** (one tap; supersedes the old link and redraws the QR). Note on screen: "Anyone with this link can sign: only show it to the homeowner." The three scripts (`qr-code.js`, `phone-share.js` if absent, `sign-link-panel.js`) load on the first click, never at boot.

## Not done

- The estimate / deal-page "Send to homeowner" screens (Q59) are not changed: their link is minted by a different path (`CloseBoard.getAcceptLink`, a deal accept token, not `createSignRequest`), so showing the panel there needs a second mint adapter and a different "new link" rule. Left for a follow-up.
- Automatic email reminders every 2 days (Q61) are not built.
- Text reminders stay manual until the carrier approval.

Tests: `tests/sign-link-panel-2026-11-18.test.js`.
