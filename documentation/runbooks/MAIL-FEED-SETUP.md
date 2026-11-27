# Mail feed setup (iCloud + Gmail, read-only)

Added 2026-11-25 (roadmap step 17 part A, [bots/agents/schedules review §4](../audit/BOTS-AGENTS-SCHEDULES-REVIEW-2026-11-22.md)).

`mailFeed` (`functions/mail-feed.js`) runs every 15 minutes. It copies a small,
masked record of each new inbox message into Firestore so the office team can
work from the server instead of a signed-in Chrome. It **only reads**:

- **iCloud** (the one combined inbox that holds jd@ and info@): IMAP over TLS
  to `imap.mail.me.com:993`, INBOX opened read-only (EXAMINE), bodies read with
  BODY.PEEK. Nothing is marked read, moved, flagged, deleted or drafted.
- **Gmail**: the Gmail API with the `gmail.readonly` scope only, GET requests
  only. A token with any other scope is refused.

What is stored, per message, in `mail_feed/{companyId}/messages` (server only;
the Firestore rules deny every client): which of your inboxes it was sent to,
the sender's name and domain (the full address only as a hash, used to match
a sender to a lead; it is not anonymous to anyone who already has the address),
the subject and the first ~500 characters with phone numbers (including 7-digit
local ones), email addresses, one-time codes and links masked (a link keeps only
its site name), when it arrived, whether it was unread, and its labels or
mailbox. A sign-in, password-reset or verification email keeps no body text at
all. Records older than 30 days are deleted automatically, on every run, even
while the feed is turned off. The first run reads the last 3 days; after that
it reads from the last successful run.

It ships **dark**: it does nothing until you set the secrets below AND turn it on.

## 1. iCloud app-specific password (you do this; never paste it in chat)

1. On your iPhone: Settings > your name > Sign-In & Security > App-Specific
   Passwords (or sign in at account.apple.com > Sign-In and Security >
   App-Specific Passwords). Two-factor authentication must be on.
2. Generate a password and name it something like `CRM mail feed`. Apple shows
   it once, in the form `xxxx-xxxx-xxxx-xxxx`.
3. From the repo folder on your computer, store it and the sign-in name as
   secrets. Each command prompts for the value; type or paste it there, not on
   the command line:

   ```
   firebase functions:secrets:set ICLOUD_IMAP_USER --project nobigdeal-pro
   firebase functions:secrets:set ICLOUD_IMAP_APP_PASSWORD --project nobigdeal-pro
   ```

   `ICLOUD_IMAP_USER` is the Apple ID email of the account that holds the
   combined inbox (usually the primary @icloud.com address, not the custom
   domain alias).

To revoke it later: delete that password on the same Apple screen. The feed
then fails its iCloud sign-in and the cron watcher tells you.

## 2. Gmail OAuth client + refresh token (read-only)

1. In the Google Cloud console for the `nobigdeal-pro` project: APIs & Services >
   Library > **Gmail API** > Enable.
2. APIs & Services > OAuth consent screen: User type External (or Internal on a
   Workspace account), add yourself as a test user, add only the scope
   `https://www.googleapis.com/auth/gmail.readonly`. **Publish the app to
   "In production"** (a "Testing" app's refresh tokens expire after 7 days);
   an unverified app with a sensitive scope still works for your own account,
   it just shows a warning screen you click through once.
3. APIs & Services > Credentials > Create credentials > OAuth client ID >
   type **Web application**; under Authorized redirect URIs add
   `https://developers.google.com/oauthplayground`. Keep the client ID and
   client secret for step 5.
4. Open the OAuth 2.0 Playground (developers.google.com/oauthplayground). Gear
   icon > tick "Use your own OAuth credentials" > enter the client ID and
   secret. In Step 1 type the single scope
   `https://www.googleapis.com/auth/gmail.readonly` (nothing else), Authorize,
   sign in with the Gmail account to read, then Step 2 > "Exchange
   authorization code for tokens". Copy the **refresh token**. Close the tab.
5. Store all three:

   ```
   firebase functions:secrets:set GMAIL_OAUTH_CLIENT_ID --project nobigdeal-pro
   firebase functions:secrets:set GMAIL_OAUTH_CLIENT_SECRET --project nobigdeal-pro
   firebase functions:secrets:set GMAIL_OAUTH_REFRESH_TOKEN --project nobigdeal-pro
   ```

To revoke it later: myaccount.google.com > Security > Third-party access >
remove the app.

You can set up only one of the two mailboxes; the feed reads whichever has all
of its secrets.

## 3. Turn it on

1. In `functions/.env.nobigdeal-pro` (by PR), add:

   ```
   MAIL_FEED_ENABLED=true
   MAIL_FEED_INBOXES=<jd address>,<info address>
   ```

   `MAIL_FEED_INBOXES` is the list of your own addresses the feed matches in
   each message's To and Cc lines to record which inbox it was sent to (a
   message to neither is stored with `to: null`). Non-secret, comma-separated.
2. Secrets are bound at deploy time, so the function must be deployed after
   the secrets are set. The merge of that PR deploys functions; if the PR was
   merged before the secrets were set, redeploy just this function:
   `firebase deploy --only functions:mailFeed --project nobigdeal-pro` (or see
   [FUNCTIONS-DEPLOY-SKIP](FUNCTIONS-DEPLOY-SKIP.md) for forcing a CI functions deploy).
3. Check: in the Firebase console, Firestore > `mail_feed_state` > your company
   id shows `sources.icloud.lastOkAtMs` / `sources.gmail.lastOkAtMs` and a
   `lastCount`. Logs show one `mail_feed_run` line per run with counts only.

## 4. Turn it off

- **Fastest:** set `MAIL_FEED_ENABLED=false` in `functions/.env.nobigdeal-pro`
  (by PR) and deploy; every run is then one `mail_feed_off` log line.
- **One mailbox only:** revoke that mailbox's password or token (above), or
  set its secret back to the stub with
  `firebase functions:secrets:set ICLOUD_IMAP_APP_PASSWORD --project nobigdeal-pro`
  and the value `__unset__`, then redeploy `mailFeed`.
- Stored records still age out after 30 days while the feed is off (every run
  deletes old ones without touching a mailbox). To clear them at once, delete
  `mail_feed/{companyId}` in the Firebase console.

## When it fails

A sign-in or read failure (wrong or revoked password, expired token, IMAP or
API error) marks the run failed in the cron ledger, so **cronDeadman** tells
you, and pings its own `mail-feed` Healthchecks check `/fail`
([HEALTHCHECKS-SETUP](HEALTHCHECKS-SETUP.md); create that check when you turn
the feed on). The other mailbox keeps running. Two more conditions also mark a
run failed: Gmail holding more inbox mail since the last good run than one run
can list (the oldest were skipped), and a capped run that could not move past
a pile of messages with the same arrival time.
The log line `mail_feed_source_failed` names the mailbox and the error with
emails and phone numbers masked; it never contains a password or token.
