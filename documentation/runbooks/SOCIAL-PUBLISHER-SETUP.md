# Social Publisher setup — connect Facebook + Instagram to Social Studio

*Written 2026-10-04 with the Social Studio build (PR "feat(social): Social Studio").
Meta's docs were checked on the web on **2026-10-04** — see "What Meta's docs say" at the bottom.*

Social Studio (CRM → Insights → **Social Studio**, or `/pro/social.html`) drafts,
schedules and posts your social media from the CRM, so you can drop Metricool.
It works today without any setup: everything you approve lands in **Ready to
post**, where you copy the caption, share the photos and tap **Mark posted**.
This runbook turns on **automatic posting** to your Facebook Page and Instagram.

Nothing posts by itself until you do all three:

1. the Meta secrets below are set,
2. functions are redeployed (so they pick up the secrets),
3. **Social Studio → Settings → Auto-publish** is switched on.

---

## 1. Make sure Instagram is a Business account linked to your Page (phone, 3 min)

1. Instagram app → your profile → ☰ → **Settings and activity** → **Account type and tools** →
   it should say **Business** (switch to a professional → Business account if not).
2. Same menu → **Sharing to other apps / Accounts Center** → make sure your
   **No Big Deal Facebook Page** is connected to this Instagram account.

## 2. Create the Meta app — with YOUR account (phone or computer, 10 min)

A computer is easier for this part, but a phone browser works ("Desktop site" on).

1. Go to **developers.facebook.com** → log in with the Facebook account that is
   an admin of the NBD Page → **My Apps** → **Create app**.
   (First time: accept the developer terms and verify your phone.)
2. Use case: choose **Other** → **Next** → app type **Business** → **Next**.
3. App name: `NBD Social Studio`. Contact email: `jd@nobigdealwithjoedeal.com`.
   Business portfolio: pick your NBD business portfolio if you have one (fine to skip). **Create app**.
4. In the app dashboard, **Add products** → add **Facebook Login for Business**
   (only so the token tool can ask for permissions) and **Instagram** (the
   "API setup with Facebook login" option).

**No App Review is needed.** A *Business* type app has no Development/Live
switch; it gets **Standard Access** to its permissions automatically, and
Standard Access works on data owned by people who have a **role on the app** —
you, the app admin, posting to your own Page and your own Instagram. App Review
(Advanced Access) is only needed to post for *other people's* Pages.

## 3. Get a long-lived Page token (10 min)

1. Open **developers.facebook.com/tools/explorer** (Graph API Explorer).
2. Top right: **Meta App** = `NBD Social Studio`. **User or Page** = *Get User Access Token*.
3. Add these permissions, then **Generate Access Token** and approve the popup
   (pick the NBD Page and the Instagram account when asked):
   - `pages_manage_posts`
   - `pages_read_engagement`
   - `pages_show_list`
   - `instagram_basic`
   - `instagram_content_publish`
   - `business_management` (only if the popup can't see your Page without it)
4. Copy the token. It is **short-lived** (about an hour) — trade it for a long-lived one:
   open **developers.facebook.com/tools/debug/accesstoken**, paste it, **Debug**,
   then **Extend Access Token** at the bottom. Copy the new long-lived *user* token.
5. Back in the Graph API Explorer, paste the long-lived user token into the token
   box and run: `GET me/accounts?fields=id,name,access_token`
   - `id` next to your Page name → this is **META_PAGE_ID**
   - `access_token` next to it → this is **META_PAGE_ACCESS_TOKEN**. A Page token
     made from a long-lived user token **does not expire** (it stops working only
     if you change your Facebook password, remove the app, or lose Page admin).
6. Still in the Explorer, run: `GET <META_PAGE_ID>?fields=instagram_business_account`
   - the `id` inside `instagram_business_account` → **IG_BUSINESS_ACCOUNT_ID**
7. Check the token: paste the Page token into the Access Token Debugger — it should
   say **Expires: Never** and list the scopes above.

## 4. Store the three secrets (computer with gcloud, 2 min)

Never paste these into a chat, a file in the repo, or a text. Run in a terminal
logged in to the `nobigdeal-pro` project. Each command asks you to paste the value
(it is not echoed and does not land in your shell history):

```bash
gcloud config set project nobigdeal-pro
printf "Page token: " && read -rs V && printf %s "$V" | gcloud secrets versions add META_PAGE_ACCESS_TOKEN --data-file=- && unset V; echo
printf "Page id: " && read -r V && printf %s "$V" | gcloud secrets versions add META_PAGE_ID --data-file=- && unset V
printf "IG business account id: " && read -r V && printf %s "$V" | gcloud secrets versions add IG_BUSINESS_ACCOUNT_ID --data-file=- && unset V
```

(The secrets already exist — the deploy creates them with an `__unset__`
placeholder the first time this code deploys. If `versions add` says the secret
does not exist, run `gcloud secrets create <NAME> --replication-policy=automatic`
first, then the line again.)

Same thing with the Firebase CLI if you prefer: `firebase functions:secrets:set META_PAGE_ACCESS_TOKEN`.

## 5. Redeploy and switch it on

1. Functions read secret values when they deploy, so redeploy the publisher once:
   `firebase deploy --only functions:socialPublisher` — or just merge the next
   PR to main (every push to main deploys functions).
2. CRM → **Social Studio → Settings**: turn on **Auto-publish**, leave **Facebook
   Page** and **Instagram** on.
3. Test: draft a post, approve it with a time 10 minutes out, and watch it go from
   *Scheduled* → *Posted* with a **View post** link. Open that link from a phone
   that is **logged out** of Facebook to confirm the public can see it.

## How the publisher behaves (so nothing surprises you)

- Runs every 5 minutes. Posts only items that are **approved + scheduled + due**.
- **Not connected yet** (secrets missing) → the post moves to **Ready to post** and
  you get one bell notification. Nothing fails silently.
- **Meta hiccup** (rate limit, outage) → retried 5 min, 10, 20, 40… up to 5 tries,
  then **Failed** + a bell/push notification with Meta's error.
- **Network drop at the moment of posting** → **Failed** ("check the page before
  re-approving"). It never retries that one by itself, so you never get a double post.
- A caption that names a customer, a street, a GPS spot, or says anything about
  claims-handling or deductibles is **refused** at approval (the sentence is removed)
  and again at posting time.
- Photos are always the cleaned copies (re-encoded, GPS/EXIF removed) served from
  `nobigdealwithjoedeal.com/api/social-media?k=…` — never the raw job photos.
- Kill switch for everything: set `SOCIAL_PUBLISHER_DISABLED=true` in
  `functions/.env.nobigdeal-pro` and deploy. Per-platform switches are in Settings.
- Instagram allows 100 API posts per 24 hours per account — far above what we use.

## Google Business Profile

Built as a stub, **off**. It turns on when Google approves Business Profile API
access (case 8-9748000042165) — the same five `GBP_*` secrets the all-reviews
sync uses (see `functions/google-reviews.README.md`), plus
`SOCIAL_GBP_ENABLED=true` in `functions/.env.nobigdeal-pro`. Until then GBP posts
go to Ready to post.

## TikTok, Nextdoor, LinkedIn, X

Always the **Ready to post** queue: open it on your phone, **Copy caption**,
**Share photos** (opens the iPhone share sheet with the photos and caption), post
in the app, then **Mark posted** and paste the link.

## Running Metricool in parallel, then cancelling (2–4 weeks)

1. **Week 0:** keep Metricool exactly as it is. In Social Studio, connect Meta (above)
   but schedule only *new* posts there — do not re-create posts already queued in Metricool.
2. **Weeks 1–2:** each planning session, use **Plan weeks** in Social Studio instead
   of Metricool. Approve each draft. Check each day that the posts went out (the
   calendar shows *Posted* with a link) and look at one on Facebook and one on Instagram.
3. **When Metricool's queue is empty** and two straight weeks posted from Social
   Studio with no failures you couldn't explain, export your Metricool history
   (Metricool → Planning → list view → export, and its analytics PDF/CSV if you want
   the numbers), then cancel the Metricool subscription.
4. Social Studio → **All & export** → **Export JSON** / **Export CSV** any time —
   every caption, photo link, schedule and result URL. That file is yours.

## What Meta's docs say (checked 2026-10-04)

- Instagram content publishing: single image = `POST /<IG_ID>/media` (image_url,
  caption) then `POST /<IG_ID>/media_publish` (creation_id); carousel = up to 10
  child containers with `is_carousel_item`, a `media_type=CAROUSEL` parent with
  `children`, then `media_publish`. JPEG only, on a public URL. 100 API posts per
  24-hour moving window. Permissions: `instagram_basic`, `instagram_content_publish`,
  `pages_read_engagement`. Docs examples use Graph API **v25.0** (the version the
  code pins in `functions/social-adapters.js`).
  https://developers.facebook.com/docs/instagram-platform/content-publishing
- App types: Business apps have no app modes and rely on access levels; they are
  auto-granted Standard Access, which only reaches data owned by people with a
  role on the app (or on the business that owns it).
  https://developers.facebook.com/docs/development/create-an-app/app-dashboard/app-types
  and https://developers.facebook.com/docs/graph-api/overview/access-levels/
- Caution for *consumer*-type apps only: data an app creates while in Development
  mode "can only be seen by role users" until it goes Live.
  https://developers.facebook.com/docs/development/build-and-test/app-modes —
  that is why step 2 says **Business** type, and why step 5 checks a real post from
  a logged-out phone.
