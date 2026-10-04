# Next session — handoff 2026-10-04

A very long "keep going" day (10-03 night → 10-04 evening). Around 95 PRs
merged since 10-03. The repo moved to the **NBDPRO** org so GitHub's merge
queue could replace the hand-run merge chains. Jo then pivoted to
**owning our own software**: a vendor cost/lock-in audit, and replacements
built for the paid or dead services. About 30 PRs were still in the queue
or held when this was written.

## 0. Read first — things that bite

- **Repo is `NBDPRO/nobigdealwithjoedeal.com`.** Merge queue ruleset
  24456328: squash, ALLGREEN, 16 required checks. `@shard2` is not
  required yet: add it once #2156 (deflake) has a few green runs.
  - Enqueue: `gh pr merge N --squash`.
  - Jump: GraphQL `enqueuePullRequest(jump:true)`, after the PR's own checks pass.
- **Queue ejections, and what caused them:**
  - `checks_timed_out` came from a runner backlog. The queue timeout is now **360 min**.
  - `UNMERGEABLE` came from any line that every PR edits. FLOORS in
    `scripts/run-test-manifest.js` was the big one, so **#2167 makes
    over-floor a warning**. **Never edit FLOORS per PR again.**
  - The E2E spec list moves to `tests/e2e/authed-specs.txt` (#2155).
  - To learn why a PR left the queue, read `RemovedFromMergeQueueEvent.reason`.
- **Tooling lives in `C:\Users\jonat\nbd-ops\`** (see its README), not
  in the old session scratchpad:
  - `mq-overnight.sh` is the autopilot.
  - `requeue.sh <worktree> 0` catches a PR up with main.
  - `helper-preamble.md` is the helper rules.
- **Before running the functions emulator, write dummy secrets to
  `functions/.secret.local`.** Without them it loads REAL Twilio and
  Resend keys, and two real emails went out from helpers on 10-03.
- Fake keys in tests must be built at runtime (`'sk-' + 'ant-…'`). The
  CI grep and GitHub push protection flag literal key shapes (#2148).
- Zelle text is **(859) 420-7382 or jd@**, NOT info@. Documents and
  letterhead stay info@.

## 1. Restart checklist (2 minutes)

1. `gh pr list -R NBDPRO/nobigdealwithjoedeal.com --state open`. Then
   read the queue with GraphQL `mergeQueue(branch:"main"){entries{…}}`.
2. Start the autopilot in the background:
   `bash /c/Users/jonat/nbd-ops/mq-overnight.sh`. Its HOLD list is
   `2135 2143 2149 2150 2146 2159`; its WAKE_ON list is `2132 2137 2141 2135`.
3. Check whether Reel Studio has a PR. If not, relaunch it from
   `C:\Users\jonat\nbd-ops\reel-studio-brief.md`. If a `feat/reel-studio`
   worktree exists, continue it.
4. Confirm the deploys landed with
   `gh run list --workflow firebase-deploy.yml`. Once #2155 is live, also
   check `/version.json`.

## 2. Open PRs at handoff

**In the queue, or armed to join it.**
- **Older work:** #2132, #2137, #2139, #2140, #2141, #2142, #2145, #2147,
  #2148, #2152, #2153.
- **Infra:** #2155 (CI speed: lazy functions, deploy verify, spec-list
  file, self-hosted Firebase SDK) and #2156 (shard2 deflake, which fixed
  two real offline-boot bugs in game-card and my-skin).
- **Docs:** #2157 (vendor audit). It was ejected once by
  `checks_timed_out` and has been re-armed.
- **Tenant bots:** #2158.
- **Vendor replacements:**
  - #2160: FormSubmit, EmailJS and the dead weather APIs removed;
    Google tiles → Esri/USGS; plus a KY fix to a rep coaching tip.
  - #2161: 11 dead integrations removed.
  - #2162: **Social Studio** (owned Metricool replacement).
  - #2163: Oaks form → our intake.
  - #2164: **own roof measure** via the Google Solar API (Instant Roofer
    becomes the fallback).
  - #2165: **backups** (vendor-config bucket, daily Firestore backup
    schedule, off-project copies).
  - #2166: **BoldSign retired**, with our own e-sign at full parity.
  - #2168: Maps solar uses the server; no key on phones. Stacks on #2164.
  - #2169: Voice Memo → Groq.
- **#2167:** the FLOORS warning. It was jumped to the front.

**Held, rebuild by hand after their bases merge.**
- **#2135** (getting paid): stacked on #2132 and squash-stale. Rebuild by
  cherry-picking its own commits onto main.
- **#2143** (receipts, Zelle/ACH): after #2135.
- **#2149** (contract cancel forms): after #2141. **It overlaps #2166**,
  so skip adding cancel forms when `cancelFormsIncluded` is set, or
  estimate contracts get them twice.
- **#2150** (numbers): after #2137. It holds migration 007/008, in order.
- **#2159** (catch-up screen): after #2150 and #2135.
- **#2146** (Pro landing page): refresh its copy once #2130, #2135, #2137
  and #2158 are in, then flip the "bots coming soon" line.

## 3. After the deploys (Jo approved the cleanup in principle; confirm each delete)

- **#2161:** first `gcloud functions delete` the 3 Swath functions, then
  delete the 11 dead secrets. The list is in the #2161 body.
- **#2166:** first delete `sendEstimateForSignature` and `esignWebhook`,
  then `BOLDSIGN_API_KEY` and `BOLDSIGN_WEBHOOK_SECRET`. **Jo cancels
  BoldSign only after this.**
- **#2169 + #2161:** a follow-up removes `DEEPGRAM_API_KEY` from
  `functions/integrations/_shared.js` and the `configured.deepgram` line
  in `handlers/integrations.js`. After that, delete the secret.
- **`docs/privacy.html`** still names removed vendors: Swath, HailTrace,
  Upstash, Deepgram, Kie.ai, BoldSign. Trim the list after these merge;
  it's an accuracy fix.
- **Still open from earlier:**
  - 3 client-error alert policies;
  - Today migration 007;
  - confirm the old stormWatch/checkStormAlerts functions are deleted;
  - unify paid-in-full;
  - rename the STOP/HELP sender to "No Big Deal Home Solutions";
  - a homeowner /terms page.

## 4. Waiting on Jo

1. **Sign in to Stripe and Bland in Chrome.** The billing pull stopped at
   their login pages; Google Cloud was pulled. Stripe gives card vs ACH
   fees, the biggest saving. Bland gives minutes and $, which settles
   whether building our own voice agent pays off.
2. **Solar key** (the API is already enabled):
   `gcloud services api-keys create --project nobigdeal-pro --display-name="NBD Solar (server)" --api-target=service=solar.googleapis.com`,
   then `firebase functions:secrets:set SOLAR_API_KEY`. Next, run
   `scripts/measure-compare.js --live` on about 10 known roofs.
3. **Oaks lead alerts:** `companyProfile/oaks` has no alert email or
   phone, so alerts fall back to Jo. Jo picks an inbox and a number: the
   setup used joe@oaksrfc.com and +15138275297; the site's mail link uses
   scott@oaksroofingandconstruction.com. That's a prod write.
4. **Meta Business app for Social Studio:** about 15 minutes; see
   `documentation/runbooks/SOCIAL-PUBLISHER-SETUP.md` once
   #2162 merges. Run Metricool in parallel for 2–4 weeks, then cancel it.
5. **Cal.com API key** → `CALCOM_API_KEY`, so the backup exports cover Cal.com.
6. **18 Healthchecks checks:** from #2155's runbook.
7. **Older items:** Stripe ACH toggles and webhooks; attorney review
   (lien waiver, change order, right-to-cancel, KRS 367.390); the
   crosshair daylight test; the iPhone offline test; the A2P submission
   (#2154 merged; needs the EIN letter); the data catch-up session once
   #2159 is live.

## 5. Decisions recorded today

- **Own our software.** The priority is services that cost more than our
  own build would. Free or near-free (Resend, Groq) can stay, each with
  an exit note. See
  `documentation/audit/VENDOR-COST-LOCKIN-2026-10-04.md`,
  once #2157 merges.
- **Google Cloud actual spend:** Apr–Sep $406 total, 89% of it Functions
  (min-instances ~$70/mo Jun–Aug, ~$7 in Sep). No Maps charges.
- **Measurement:** Jo does 20+ measures a month, so we own it with the
  Solar API; Instant Roofer is the fallback.
- **Bland → own voice agent:** wait for the real Bland bill. The rough
  break-even is ~$250/mo of Bland spend.
- **Reel Studio** (from the "$39 content stack" reel): the ffmpeg
  pipeline, Whisper captions, our own templates, and a Claude-vision
  privacy check. Skip AI b-roll, yt-dlp scraping and Apify. SuperGrok and
  Gemini AI Pro images are upload-only, for tips and PSAs, never on job
  showcases.
- **Backups:** the private vendor-config bucket, the daily Firestore
  backup schedule (14 weeks), and off-project copies in `nobigdeal-backups`.
  A live restore into a new database is to be done with Jo watching.
