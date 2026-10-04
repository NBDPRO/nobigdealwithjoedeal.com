# Reel Studio — our own short-form video pipeline (2026-10-04)

Built into Social Studio ([SOCIAL-PUBLISHER-SETUP](../runbooks/SOCIAL-PUBLISHER-SETUP.md)).
No paid video SaaS and no Remotion/HyperFrames dependency. It stacks on the
Social Studio PR (#2162). If that PR changes before it merges, rebase this one.

## What Jo gets

Social Studio has a new **Reels** tab:

- **Upload clips.** Drone clips, phone walk-arounds, talking-to-camera clips
  and photos go up from the phone with a resumable upload into a private,
  company-scoped Storage path. The server converts each one to a clean
  intermediate. GPS and every other piece of metadata are stripped, and the
  raw upload is deleted.
- **+ New reel.** Pick a template, a shape (9:16 at 1080×1920, or 1:1 at
  1080×1080), a finished job's photos and/or uploaded clips, then tap Render.
  - Photo slideshow (Ken Burns pans).
  - Before / after reveal (wipe or slide; photos or clips).
  - Job of the week (town, package/tier, shingle only, and never a price).
  - Drone cut (the best N seconds, optional 1x/2x/1x speed ramp, silent).
  - Talking to camera (trim plus burned-in captions).
  - Every reel gets the brand intro and outro cards: navy `#1a3057`, the
    orange rule `#bd5728`, the NBD logo and Barlow Condensed.
- **Privacy check.** After each render, one frame every ~2 s goes to Claude
  vision (Haiku 4.5). It looks for readable house numbers, license plates,
  street signs and faces, and it also picks the hero thumbnail frame.
  - A flagged reel cannot be approved until Jo taps **Looks fine — confirm**
    or **Blur flagged areas**.
  - Blur is only offered when every flag has a box. Otherwise Jo must confirm.
  - If the check could not run (AI switched off, over budget, vision error, or
    the emulator), the reel needs Jo's confirmation too. It never passes
    silently.
- **Send to Social Studio.** This makes a normal draft for each platform
  (format `reel`), with a proposed time of tomorrow at 10:00 ET, so it shows
  on the calendar.
  - Approval goes through `socialApprovePost`, which now also checks the
    reel's privacy gate.
  - Facebook (Page video) and Instagram (Reels) post automatically once
    approved.
  - Every other platform goes to **Ready to post**, with **Share video** /
    **Download MP4**.
- **AI graphic.** Jo can upload an image he made in SuperGrok or Gemini (they
  are consumer subscriptions, not API keys).
  - It becomes a tip or storm-season draft tagged `aiGenerated: true`, and the
    caption says "(Graphic made with AI.)".
  - It can never be a job showcase or part of a reel. This is enforced in
    the logic (`checkAiImageRule`), in the callables, in `socialApprovePost`
    and at publish time (`postBlockers`), and in `firestore.rules`.

## Render runtime: 2nd-gen Cloud Functions + ffmpeg-static (not Cloud Run)

| | 2nd-gen function (chosen) | Cloud Run job |
|---|---|---|
| Deploy | the existing `firebase deploy --only functions` on push to main | a container image, Artifact Registry and a separate deploy step: new pipeline |
| Timeout | 540 s event-driven (Firestore / Storage triggers), 60 min HTTP | 24 h |
| Memory / CPU | up to 32 GiB; we use 4 GiB / 4 vCPU | similar |
| ffmpeg | `ffmpeg-static` npm (static Linux build fetched by `npm ci` in Cloud Build) | any apt package |

A 90 s 1080×1920 reel is about 2,700 frames. libx264 `veryfast` with
overlays runs at roughly 30–60 fps on 4 vCPU, so a render takes about 60–150 s,
well inside 540 s. Measured locally: a 7 s job-of-the-week took about 3 s, and
a 2-photo slideshow about 7 s, both including the intro and outro.

- `/tmp` on gen2 is memory-backed, so the worker removes its work dir in a
  `finally` block.
- The 4 GiB budget is shared by the intermediates (≤180 s, ≤1920 px) and the
  output.
- Cloud Run stays the escape hatch if reels ever need to exceed about 5 min
  of render time.

Functions (`functions/reel-studio.js`):

- `reelRenderWorker`: Firestore trigger on `companies/{c}/reels/{id}`.
  4 GiB / 4 vCPU / 540 s, `concurrency: 1`, `maxInstances: 3`.
- `reelIngestUpload`: Storage finalize, `reel-uploads/` only. Same size as
  the worker.
- `reelCleanup`: daily at 04:15 ET.
- Eight callables, all behind the Social Studio `requireSocialManager` gate
  (owner, company_admin, or platform admin).

## Cost per reel (estimate)

| Piece | 60 s reel | 90 s reel |
|---|---|---|
| Render compute (4 vCPU + 4 GiB × ~80–120 s at $0.000024/vCPU-s + $0.0000025/GiB-s) | ~$0.009 | ~$0.013 |
| Ingest transcode per uploaded clip (~20–60 s) | ~$0.002–0.007 each | same |
| Privacy check: 30–45 frames × ~620 tokens (512 px) on Haiku 4.5 ($1/M in, $5/M out) | ~$0.022 | ~$0.032 |
| Whisper captions (talking head only; Groq turbo $0.04/audio hour) | ~$0.001 | ~$0.001 |
| Storage + egress (a 10–25 MB MP4) | < $0.01 | < $0.01 |
| **Total** | **~$0.04** | **~$0.05–0.06** |

The vision check dominates the cost. Cloud Run's free tier (180k vCPU-s a
month) covers the compute at Jo's volume. `estimateCostUsd()` in
`functions/reel-logic.js` encodes this table, and the test pins a 60 s reel
at under $0.10.

## Guards

- **Daily cap.** 20 renders per company per Eastern day. Renders, blurs and
  retries all count (`companies/{c}/reel_usage/{day}`, taken in a
  transaction).
- **Length.** A reel is at most 90 s. Ingest keeps the first 180 s of a clip.
  Uploads are capped at 500 MB in both `storage.rules` and the callable.
- **AI kill switch.** `feature_flags/global.aiDisabled` stops both vision and
  Whisper. Vision also shares the per-user monthly vision budget with
  photo-vision and receipt-vision (`userCostMeter/{uid}__{month}.visionUsd`,
  same plan table).
- **No real API calls in the emulator.** The `FUNCTIONS_EMULATOR` gate skips
  vision and Whisper. When ffmpeg is missing, the emulator renders a 3 s stub
  MP4 (`functions/assets/reel/emulator-stub.mp4`).
- **Cleanup.**
  - The raw upload is deleted the moment it is ingested (success or failure).
  - Intermediates older than 14 days expire.
  - Abandoned upload slots, and any stray `reel-uploads/` object older than a
    day, are deleted daily.
  - Optional belt and braces: a GCS lifecycle rule (see the runbook).
- **Metadata.** Every ffmpeg output (ingest, segments, concat, frames, audio,
  blur) uses `-map_metadata -1` plus per-stream variants, `-map_chapters -1`,
  `-dn -sn` and `+bitexact`, and maps only the first video and audio streams.
  Job photos are re-encoded with sharp before they reach ffmpeg.
- **Captions and on-screen text** pass through the Social Studio filter
  (`cleanCaption`): private terms of the source lead, streets / house numbers,
  ZIP, phone, email, GPS, Kentucky claim wording, and deductibles.
  - Dropped speech is removed from the captions and flags the reel. The audio
    still says it, so Jo must confirm.
  - On-screen text also refuses `$`, cost, margin and per-SQ.

## Where things live

- Logic (pure): `functions/reel-logic.js`. It holds the templates as data,
  render plans and argv, caption grouping, the safety filter, flags and
  gating, blur regions, the AI rule and the cost model.
- ffmpeg runner: `functions/reel-ffmpeg.js`.
- Server: `functions/reel-studio.js`.
- Publisher:
  - `functions/social-adapters.js` covers FB `/{page}/videos` with
    `file_url`, and IG `media_type=REELS` with container polling. A
    still-processing container comes back as a retryable error carrying
    `resume.containerId`, so the next attempt polls the same container
    instead of uploading again.
  - `functions/social-publisher.js` holds `postBlockers` and the video routing.
- Media route: `socialMedia` now also serves `.mp4` with HTTP Range (206).
  iPhone Safari needs this to play video.
- Whisper: `transcribeGroqBuffer({ words: true })` in
  `functions/integrations/voice-intelligence.js` asks for word timestamps.
  It is off by default, so existing callers are unchanged.
- Page: `docs/pro/social.html` (Reels tab), `docs/pro/js/pages/social-reels.js`
  and `docs/pro/js/reel-studio-logic.js`.
- Brand assets for ffmpeg live in `functions/assets/reel/`:
  `BarlowCondensed-800/600.ttf` and `logo.png`.
  - The TTFs were converted from `docs/assets/fonts/*.woff2` because
    FreeType/drawtext does not read WOFF2.
  - Barlow is under the SIL Open Font License.
- Rules:
  - `firestore.rules`: `reels`, `reel_media` and `reel_usage` are readable by
    managers and written only by the server. `reelId`, `video` and
    `aiGenerated` on a post are frozen, and an AI post can never become a job
    showcase.
  - `storage.rules`: `reel-uploads/{c}/{uid}/{id}` is create-only and write-once.
- Index: a `reel_media.createdAtMs` COLLECTION_GROUP fieldOverride for the
  cleanup sweep.

## Tests

- `tests/reel-studio-2026-10-04.test.js` (unit, 150 checks; node bucket).
  These checks run real ffmpeg:
  - a clip carrying `location` / ISO6709 / `make` / `creation_time` atoms,
    with a positive control proving the atoms were there;
  - the full worker: a job photo with EXIF+GPS → a 1:1 job-of-the-week reel,
    fake vision flags a house number → blur re-render → drafts re-pointed →
    gate opens;
  - ingest of a GPS-tagged `.mov`.

  It also covers the publisher video idempotency (FB, overlapping runs, IG
  resume) and the AI rule. Break-tests were run on 7 mutations, and each one
  turned the matching assertions red.
- `tests/e2e/reel-studio.spec.js` (390×844, @gauntlet, functions emulator):
  1. A seeded finished job.
  2. Slideshow reel.
  3. Rendered (stub locally, real ffmpeg where ffmpeg-static is installed).
  4. Privacy "could not run".
  5. Send to Social Studio.
  6. Draft chip on the calendar.
  7. Approve refused.
  8. Confirm.
  9. Approve schedules it.
- Rules:
  - `tests/firestore-rules.test.js` §49: 16 checks.
  - `tests/storage-rules.test.js` "reel studio": 14 checks.

## What Jo must do

1. Nothing new in Meta. Reels use the **same** Page token and the same scopes
   as photos: `pages_manage_posts`, `pages_read_engagement` and
   `pages_show_list` for Page video, plus `instagram_content_publish` for
   Reels. See the runbook section dated 2026-10-04.
2. After the merge, the next functions deploy ships ffmpeg-static (Cloud
   Build downloads its Linux binary from GitHub during `npm ci`).
3. Optional: add the GCS lifecycle rule in the runbook.
4. Try it once on the phone with a real drone clip, and look at the privacy
   flags it raises before the first real post.

## Follow-ups (not built)

- Tenant branding: the cards use NBD's logo, colours and site for every company.
- Captions on templates other than talking-head. Music beds. Multi-clip
  timelines (cutting several walk-around clips together).
- Facebook Reels (`/{page}/video_reels` upload phases) instead of a plain
  Page video.
