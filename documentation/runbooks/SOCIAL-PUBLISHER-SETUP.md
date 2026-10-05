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

---

## Reels (Reel Studio) — added 2026-10-04

*Checked against Meta's docs on **2026-10-04**. Code: `functions/reel-studio.js`,
the publishing in `functions/social-adapters.js`. Design notes:
[REEL-STUDIO-2026-10-04](../projects/REEL-STUDIO-2026-10-04.md).*

**No new token and no new permission.** Reels use the same three secrets and
the same Page token from steps 3–4 above:

- **Facebook Page video:** `POST /{page-id}/videos` with `file_url` (Meta
  fetches the MP4 from our `/api/social-media?k=…` URL) and `description`.
  - Permissions: `pages_manage_posts`, `pages_read_engagement` and
    `pages_show_list`. These are the scopes you already granted.
  - Meta's Graph reference lists `file_url` as "Accessible URL of a video
    file".
  - https://developers.facebook.com/docs/graph-api/reference/page/videos/
- **Instagram Reels:**
  1. `POST /{ig-user-id}/media` with `media_type=REELS`, `video_url`,
     `caption`, `share_to_feed=true` and `cover_url` (the hero frame the
     privacy check picked).
  2. Poll `GET /{container-id}?fields=status_code` until it says `FINISHED`.
  3. `POST /{ig-user-id}/media_publish`.

  Permissions: `instagram_basic` and `instagram_content_publish` (already
  granted).

  Meta's spec: MP4/MOV, H.264, AAC at up to 48 kHz, 23–60 fps, at most 1920 px
  wide, 3 s to 15 min, at most 300 MB, 9:16 recommended. Our reels are 1080×1920
  or 1080×1080, 30 fps, H.264 + AAC, and at most 90 s. Reels count toward the
  same 100 API posts per 24 h.

  https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media
  and https://developers.facebook.com/docs/instagram-platform/content-publishing

**How a reel posts:**

- Instagram processes video for a minute or more. The publisher checks a few
  times per run. If the reel is still processing, it puts the post back to
  *Scheduled* and checks **the same upload** again on the next try (5 min,
  then 10, 20, 40). It never uploads the video twice.
- A network drop at the moment of posting is marked **Failed — check the
  page** and is never retried, the same as photos.
- Google Business, TikTok, Nextdoor, LinkedIn and X take the video by hand:
  **Ready to post** → **Share video** (the iPhone share sheet) or **Download
  MP4**.

**Approval is locked until the privacy check clears.** Every rendered reel
has its frames checked (one every ~2 s) for readable house numbers, license
plates, street signs and faces. If anything is flagged, or the check could not
run, open the reel in **Social Studio → Reels** and tap **Looks fine —
confirm**. If every flag has a box, you can tap **Blur flagged areas**
instead. The publisher re-checks this right before posting.

**AI graphics** (made in SuperGrok or Gemini — those are subscriptions, not
API keys) are uploaded in **Reels → AI graphic**. They can only become a tip
or storm-season post, are tagged as AI, and the caption says so. They can
never be a job showcase or go in a reel.

**Optional storage clean-up rule** (the daily `reelCleanup` already does
this; this is a second safety net). On a computer with gcloud:

```bash
cat > /tmp/reel-lifecycle.json <<'JSON'
{"rule":[
  {"action":{"type":"Delete"},"condition":{"age":2,"matchesPrefix":["reel-uploads/"]}},
  {"action":{"type":"Delete"},"condition":{"age":30,"matchesPrefix":["reel-work/"]}}
]}
JSON
gcloud storage buckets describe gs://nobigdeal-pro.firebasestorage.app --format="default(lifecycle_config)"
```

Only run `gcloud storage buckets update gs://nobigdeal-pro.firebasestorage.app
--lifecycle-file=/tmp/reel-lifecycle.json` if the describe shows **no**
existing rules, because the update REPLACES the bucket's lifecycle config.
Never add a rule for `social-media/`: posted reels and photos are served
from there.

**Switches:**

- **Reel Studio is OFF until you turn it on** (updated 2026-10-04, post-merge
  review): **Social Studio → Settings → Reel Studio**
  (`companies/{c}/social_settings/config.reels = true`). While it is off,
  uploads, renders, blurs and retries are refused and a queued reel fails
  with "Reel Studio is off", so nothing spends compute, Claude or Groq money.
- Platform kill switch for every company:
  `feature_flags/global.reelStudioDisabled = true`.
- If the functions deploy could not download the ffmpeg binary
  (`ffmpeg-static` is an optional dependency, so the deploy still succeeds),
  creating a reel says "Video rendering is not available …". Redeploy
  functions to fix it.
- Reels follow the same **Auto-publish** and per-platform switches.
- `feature_flags/global.aiDisabled = true` stops the vision check and
  Whisper captions. Reels then need your confirmation, and talking-head reels
  render without captions.
- Each company is capped at 20 renders a day (blurs and retries count).
